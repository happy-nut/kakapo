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

  await v.openMergedView("q");
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

  const merged = v.window.buildMergedText("q");
  assert.match(merged, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "merged text keeps the canonical range");
  assert.doesNotMatch(merged, /^> /m, "merged text does not attach selected source as a blockquote");
  assert.doesNotMatch(merged, /export const line3 = 3/, "selected source text is omitted from the handoff");

  await v.openMergedView("q");
  assert.equal(v.$(".mc-merged-comment-anchor")?.textContent.trim(), expected, "rendered merged heading uses the same reference");
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

test("merged prompt: a section-less editor read on close never wipes existing comments, but real edits still sync (#5)", async () => {
  const v = await loadViewer(html);
  await v.openSourceFile("src/app.ts");
  await v.clickSourceLine(1); // 0-based line 1 -> comment on 1-based line 2
  await v.openComposer("q");
  await v.writeAndSave("why 43?");
  assert.equal(v.storedComments().length, 1, "the comment is saved");

  // Close-time reconcile receiving empty / heading-less text (a lossy editor read) must NOT delete everything.
  const guarded = v.window.reconcileMergedComments("q", "");
  assert.equal(v.storedComments().length, 1, "comment survives a section-less reconcile");
  assert.equal(guarded.remaining, 1);

  // A genuine per-section edit is still applied.
  v.window.reconcileMergedComments("q", "### @src/app.ts#L2\nrewritten question\n");
  assert.equal(v.storedComments()[0].text, "rewritten question", "an edit through the merged prompt still syncs");
  v.close();
});

test("merged prompt: comments stay visible after opening then closing the merged view (#5)", async () => {
  const v = await loadViewer(html);
  await v.openSourceFile("src/app.ts");
  await v.clickSourceLine(1);
  await v.openComposer("q");
  await v.writeAndSave("keep me");
  v.window.openMergedView("q");
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

test("merged prompt: each comment has a hamburger menu; its Remove deletes just that comment (#actions)", async () => {
  const v = await loadViewer(html);
  await v.openSourceFile("src/app.ts");
  await v.clickSourceLine(1); await v.openComposer("q"); await v.writeAndSave("first question");
  await v.clickSourceLine(0); await v.openComposer("q"); await v.writeAndSave("second question");
  assert.equal(v.storedComments().filter((c) => c.kind === "q").length, 2);

  v.window.openMergedView("q");
  await v.settle(150); // inline editor init + syncMergedAnchors
  const btns = v.$all(".mc-merged-menu-btn");
  assert.equal(btns.length, 2, "one hamburger button per comment, in the gutter overlay");
  // the buttons live OUTSIDE the contenteditable so they never enter the prompt
  assert.ok(!btns[0].closest(".mc-inline-editor"), "gutter button is not inside the editable content");

  btns[0].dispatchEvent(new v.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await v.settle(30);
  const items = v.$all("#mc-dropdown .mc-dropdown-item");
  assert.ok(items.length >= 2, "the hamburger opens the navigate/remove dropdown");
  items[items.length - 1].dispatchEvent(new v.window.MouseEvent("click", { bubbles: true, cancelable: true })); // Remove
  await v.settle(80);
  assert.equal(v.storedComments().filter((c) => c.kind === "q").length, 1, "Remove deletes exactly that comment");
  v.close();
});

test("merged prompt: emptying a comment's body removes that comment while keeping the others (#body-delete)", async () => {
  const v = await loadViewer(html);
  await v.openSourceFile("src/app.ts");
  await v.clickSourceLine(1); await v.openComposer("q"); await v.writeAndSave("keep me");
  await v.clickSourceLine(0); await v.openComposer("q"); await v.writeAndSave("delete my body");
  assert.equal(v.storedComments().filter((c) => c.kind === "q").length, 2);
  const edited = v.window.buildMergedText("q").replace("delete my body", ""); // heading kept, body blanked
  v.window.reconcileMergedComments("q", edited);
  const after = v.storedComments().filter((c) => c.kind === "q");
  assert.equal(after.length, 1, "the comment whose body was emptied is removed");
  assert.equal(after[0].text, "keep me", "the untouched comment survives");
  v.close();
});

test("merged prompt: a path with markdown-special chars (_ , __init__) round-trips without one comment swallowing others (#escape)", async () => {
  // The commented paths must exist in the review (else they'd be pruned as missing files), so build a fixture
  // that actually contains these markdown-special paths.
  const { html: escHtml } = await makeReviewHtml([
    { path: "scripts/CLAUDE.md", before: "# claude\n", after: "# claude\nmore\n" },
    { path: "src/app/shared/canonical_runtime/__init__.py", before: "x = 1\n", after: "x = 2\n" },
    { path: "src/app/shared/optimizer/__init__.py", before: "y = 1\n", after: "y = 2\n" },
  ]);
  const seeded = [
    { seq: 1, kind: "q", path: "scripts/CLAUDE.md", line: 1, code: "", text: "question A", from: 1, to: 1, side: null, anchorCode: "", anchorPresent: true, addressed: false },
    { seq: 2, kind: "q", path: "src/app/shared/canonical_runtime/__init__.py", line: 1, code: "", text: "question B", from: 1, to: 1, side: null, anchorCode: "", anchorPresent: true, addressed: false },
    { seq: 3, kind: "q", path: "src/app/shared/optimizer/__init__.py", line: 1, code: "", text: "question C", from: 1, to: 1, side: null, anchorCode: "", anchorPresent: true, addressed: false },
  ];
  const v = await loadViewer(escHtml, { seedStorage: { "kakapo-comments:/review.html": JSON.stringify(seeded) } });
  await v.settle(30);
  // The Tiptap editor escapes/normalizes emphasis in the headings: `_` -> `\_`, `__init__` -> `**init**`.
  const mangled = [
    "### @scripts/CLAUDE.md#L1",
    "question A",
    "### @src/app/shared/canonical\\_runtime/**init**.py#L1",
    "question B",
    "### @src/app/shared/optimizer/**init**.py#L1",
    "question C",
  ].join("\n");
  v.window.reconcileMergedComments("q", mangled);
  const stored = v.storedComments();
  assert.equal(stored.length, 3, "all three comments survive the round-trip");
  assert.equal(stored.find((c) => c.seq === 1).text, "question A", "the first comment keeps only its own body (no swallowing)");
  assert.equal(stored.find((c) => c.seq === 2).text, "question B");
  assert.equal(stored.find((c) => c.seq === 3).text, "question C");
  v.close();
});
