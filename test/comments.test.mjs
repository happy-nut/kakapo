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
      before: "# AGENTS\n\nGuidance for agents.\n\n## Project\n\nmonacori is a CLI.\n",
      after: "# AGENTS\n\nGuidance for agents.\n\n## Project\n\nmonacori is a small CLI.\n",
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
  assert.ok(snapshot["monacori-comments:/review.html"], "comment was persisted");
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
    electronSettings: { "monacori-comments:/review.html": [] },
  });
  await v.openSourceFile("AGENTS.md");
  await v.clickSourceLine(4);
  await v.openComposer("q");
  await v.writeAndSaveWithKeyboard("saved under electron"); // pushes onto the frozen array

  assert.equal(v.storedComments().length, 1);
  assert.equal(v.storedComments()[0].text, "saved under electron");
  // it also went back through the settings bridge for cross-restart persistence
  assert.equal(v.electronWrites()["monacori-comments:/review.html"]?.length, 1);
  v.close();
});

test("Electron bridge: appends to a frozen pre-existing thread, keeping both", async () => {
  const v = await loadViewer(html, {
    electronSettings: {
      "monacori-comments:/review.html": [
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
