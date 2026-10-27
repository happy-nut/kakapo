import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { cleanupFixtures, makeReviewHtml } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";

let html;
before(async () => {
  ({ html } = await makeReviewHtml([
    {
      path: "src/one.ts",
      before: "const firstNeedle = 1;\nconst stable = 2;\n",
      after: "const firstNeedle = 1;\nconst stable = 3;\nconst secondNeedle = firstNeedle;\n",
    },
    {
      path: "src/two.ts",
      before: "const otherNeedle = 1;\n",
      after: "const otherNeedle = 2;\n",
    },
  ]));
});
after(cleanupFixtures);

test("Cmd+F searches only the open source file and Enter / Shift+Enter navigate matches", async () => {
  const v = await loadViewer(html);
  await v.openSourceFile("src/one.ts");

  v.key("f", { metaKey: true, code: "KeyF" });
  assert.equal(v.document.activeElement, v.$("#file-find-input"));
  v.typeInto(v.$("#file-find-input"), "needle");
  await v.settle(130);

  const api = v.window.__kakapoFileFind;
  assert.equal(api.results().length, 3, "only the three matches in src/one.ts are included");
  assert.ok(api.results().every((item) => item.path === "src/one.ts"));
  assert.equal(v.$("#file-find-count").textContent, "1/3");

  v.key("Enter");
  await v.settle(30);
  assert.equal(api.active(), 1);
  assert.equal(v.$("#file-find-count").textContent, "2/3");

  v.key("Enter", { shiftKey: true });
  await v.settle(30);
  assert.equal(api.active(), 0);

  v.key("Escape");
  assert.ok(v.$("#file-find").classList.contains("hidden"));
  v.close();
});

test("diff search stays inside the active file and covers Base and Working tree panes", async () => {
  const v = await loadViewer(html);
  await v.openDiffFor("src/one.ts");

  v.key("f", { metaKey: true, code: "KeyF" });
  v.typeInto(v.$("#file-find-input"), "needle");
  await v.settle(140);

  const api = v.window.__kakapoFileFind;
  const results = api.results();
  assert.ok(results.length >= 3, "matches from both visible diff panes are searchable");
  assert.ok(results.every((item) => item.path === "src/one.ts"), "hidden changed files are excluded");
  assert.deepEqual(new Set(results.map((item) => item.side)), new Set(["old", "new"]));

  v.key("Enter");
  await v.settle(30);
  assert.ok(v.diffCaretRow(), "stepping a result moves the diff caret to its row");
  v.close();
});

test("the single Review source view handles Cmd+F without an editor-mode toggle", async () => {
  const { html: appHtml } = await makeReviewHtml([
    { path: "src/code.ts", before: "export const value = 1;\n", after: "export const value = 2;\n" },
  ], { app: true });
  const v = await loadViewer(appHtml, {
    monacoBridge: true,
    analysisBridge: () => ({ ok: true, locations: [] }),
  });
  await v.openSourceFile("src/code.ts");
  assert.equal(v.$("#editor-mode-toggle"), null);

  v.key("f", { metaKey: true, code: "KeyF" });
  assert.equal(v.document.activeElement, v.$("#file-find-input"));
  v.typeInto(v.$("#file-find-input"), "value");
  await v.settle(130);
  assert.equal(v.$("#file-find-count").textContent, "1/1");
  assert.equal(v.window.__monacoMock.editors.length, 0, "search does not mount a second editor");
  v.close();
});

test("search reveals matches inside default-folded imports in File and Diff views", async () => {
  const { html: foldedHtml } = await makeReviewHtml([
    {
      path: "src/folded.ts",
      before: "import { visibleImport } from './one';\nimport { hiddenImport } from './two';\n\nexport const value = 1;\n",
      after: "import { visibleImport } from './one';\nimport { hiddenImport } from './two';\n\nexport const value = 2;\n",
    },
  ]);
  const v = await loadViewer(foldedHtml);
  await v.openSourceFile("src/folded.ts");
  assert.equal(v.$('#source-body .source-row[data-line-index="1"]'), null, "the second import starts folded");

  v.key("f", { metaKey: true, code: "KeyF" });
  v.typeInto(v.$("#file-find-input"), "hiddenImport");
  await v.settle(130);
  assert.ok(v.$('#source-body .source-row[data-line-index="1"]'), "navigating the match opens its source fold");
  v.key("Escape");

  await v.openDiffFor("src/folded.ts");
  assert.ok(v.$(".mc-import-fold-row"), "the diff import region starts folded too");
  v.key("f", { metaKey: true, code: "KeyF" });
  // Before a single character is typed: restoring the panes rebuilds rows and re-runs the diff geometry, and
  // that used to fire at exactly two characters — a stall between two keystrokes, on a boundary nobody could
  // predict. Opening the bar is the deliberate moment; typing must never move the ground under the reviewer.
  assert.equal(v.$(".mc-import-fold-row"), null, "opening the find bar restores the folded imports");
  v.typeInto(v.$("#file-find-input"), "hiddenImport");
  await v.settle(140);
  assert.equal(v.$(".mc-import-fold-row"), null, "diff search restores both import panes before matching");
  assert.equal(v.window.__kakapoFileFind.results().length, 2, "Base and Working tree each contain the import match");
  v.close();
});

test("a broad one-character diff query stays responsive and limits painted highlights", async () => {
  const lines = Array.from({ length: 300 }, (_, index) => `i i i i # ${index}`).join("\n") + "\n";
  const { html: largeHtml } = await makeReviewHtml([
    { path: "src/large.py", before: "", after: lines },
  ]);
  const v = await loadViewer(largeHtml);
  await v.openDiffFor("src/large.py");

  v.key("f", { metaKey: true, code: "KeyF" });
  v.typeInto(v.$("#file-find-input"), "i");
  assert.equal(v.window.__kakapoFileFind.results().length, 0, "input is not blocked by synchronous matching");
  assert.equal(v.$("#file-find-count").textContent, "…");
  await v.settle(160);

  assert.equal(v.window.__kakapoFileFind.results().length, 1200, "navigation retains the complete result set");
  assert.equal(v.$("#file-find-count").textContent, "1/1200");
  assert.ok(v.$all(".file-find-row-match").length <= 48, "only a bounded set is painted into the DOM");
  v.close();
});

test("continued typing cancels a pending broad query instead of publishing stale results", async () => {
  const lines = [
    "import target from './target';",
    ...Array.from({ length: 240 }, (_, index) => `identifier_${index} = ${index}`),
  ].join("\n") + "\n";
  const { html: largeHtml } = await makeReviewHtml([
    { path: "src/typing.js", before: "", after: lines },
  ]);
  const v = await loadViewer(largeHtml);
  await v.openDiffFor("src/typing.js");

  v.key("f", { metaKey: true, code: "KeyF" });
  const input = v.$("#file-find-input");
  v.typeInto(input, "i");
  await v.settle(30);
  v.typeInto(input, "import");
  await v.settle(160);

  const results = v.window.__kakapoFileFind.results();
  assert.equal(input.value, "import");
  assert.equal(results.length, 1, "the cancelled one-character search cannot overwrite the final query");
  assert.match(results[0].row.textContent, /import target/);
  assert.equal(v.$("#file-find-count").textContent, "1/1");
  v.close();
});

// A search belongs to the file it was opened on. Carrying the query onto the next file and re-running it
// there reports a count for something the reviewer never asked about, under a bar that no longer describes
// what is on screen.
test("the find bar belongs to one file and closes when the reviewer moves to another", async () => {
  const { html } = await makeReviewHtml([
    { path: "src/first.ts", before: "export const value = 1;\n", after: "export const value = 2;\n" },
    { path: "src/second.ts", before: "export const other = 1;\n", after: "export const other = 3;\n" },
  ]);
  const v = await loadViewer(html);
  await v.openDiffFor("src/first.ts");

  v.key("f", { metaKey: true, code: "KeyF" });
  v.typeInto(v.$("#file-find-input"), "value");
  await v.settle(140);
  assert.ok(v.window.__kakapoFileFind.results().length > 0, "it matches in the file it was opened on");

  await v.openDiffFor("src/second.ts");
  await v.settle(140);
  assert.ok(v.$("#file-find").classList.contains("hidden"), "moving to another file closes the bar");
  assert.equal(v.window.__kakapoFileFind.results().length, 0, "and takes its results with it");
  v.close();
});

// ---- what the field owes the hand typing into it -------------------------------------------------
//
// Everything below types one character at a time (typeChars), which is the only way these show up:
// typeInto sets the whole value and fires one input event, so the state that a per-character refresh
// builds up between two keys never exists.

test("typing in the find field scrolls to the match without moving the caret", async () => {
  const v = await loadViewer(html);
  await v.openSourceFile("src/one.ts");
  const before = v.caretLine();

  v.key("f", { metaKey: true, code: "KeyF" });
  await v.typeChars(v.$("#file-find-input"), "secondNeedle");

  const api = v.window.__kakapoFileFind;
  assert.equal(api.results().length, 1, "the query found its match");
  assert.equal(api.active(), 0, "and the bar points at it");
  assert.equal(v.caretLine(), before, "but the caret did not follow a query that is still being typed");

  v.key("Enter");
  await v.settle(40);
  assert.equal(v.caretLine(), api.results()[0].lineIndex + 1, "Enter is what moves it");
  v.close();
});

// Before this, the reveal ran on every keystroke, and a reveal is a caret placement: setSourceCursor
// records one entry in the ⌘[/⌘] history, drops the selection, re-asserts the active hunk and repaints the
// file when the match sits inside a fold. A six-letter query cost six of those. Counted at the source
// rather than through the history, because the history coalesces nearby moves and would hide the trail in
// a small file — the call is the thing that should not happen.
test("typing in the find field places no caret at all, and one Enter places one", async () => {
  const v = await loadViewer(html);
  await v.openSourceFile("src/one.ts");
  const placeCaret = v.window.setSourceCursor;
  let placements = 0;
  v.window.setSourceCursor = function (...args) { placements += 1; return placeCaret.apply(this, args); };

  v.key("f", { metaKey: true, code: "KeyF" });
  await v.typeChars(v.$("#file-find-input"), "secondNeedle");
  assert.equal(placements, 0, "twelve characters are not twelve places the reviewer went");

  v.key("Enter");
  await v.settle(40);
  assert.equal(placements, 1, "arriving at the match is one");
  v.window.setSourceCursor = placeCaret;
  v.close();
});

// The reveal runs the view's own machinery — repaint, fold expansion, file reveal — and any of it may take
// DOM focus. The code surfaces bind no plain letters, so a field that silently lost the keyboard reads as a
// field that stopped accepting input. Both halves of the publish are checked: the synchronous one and the
// frame-deferred highlight pass.
test("the find field keeps the keyboard when the reveal steals focus", async () => {
  const v = await loadViewer(html);
  await v.openSourceFile("src/one.ts");
  const thief = v.$("#source-body");
  const original = v.window.expandSourceFindResult;
  v.window.expandSourceFindResult = function (result) {
    thief.tabIndex = -1;
    thief.focus();
    return original.call(this, result);
  };

  v.key("f", { metaKey: true, code: "KeyF" });
  const typed = await v.typeChars(v.$("#file-find-input"), "needle");

  assert.equal(typed, "needle", "every character after the first one arrived");
  assert.equal(v.document.activeElement, v.$("#file-find-input"), "and the field still owns the keyboard");
  v.window.expandSourceFindResult = original;
  v.close();
});

test("the find field keeps the keyboard when the highlight pass steals focus", async () => {
  const v = await loadViewer(html);
  await v.openSourceFile("src/one.ts");
  const thief = v.$("#source-body");
  const original = v.window.applyFileFindHighlights;
  v.window.applyFileFindHighlights = function () {
    const result = original.call(this);
    thief.tabIndex = -1;
    thief.focus();
    return result;
  };

  v.key("f", { metaKey: true, code: "KeyF" });
  const typed = await v.typeChars(v.$("#file-find-input"), "needle");

  assert.equal(typed, "needle", "every character arrived");
  assert.equal(v.document.activeElement, v.$("#file-find-input"), "and the field still owns the keyboard");
  v.window.applyFileFindHighlights = original;
  v.close();
});

// Closing the bar used to hide it while it still held the keyboard, which left focus on <body> — a surface
// that binds no plain letters, so the reviewer's next keystroke went nowhere and the field looked like it
// had stopped accepting input.
//
// The file changes here the way a --watch rebuild changes it: the active wrapper moves with no navigation
// of its own, so nothing else is handing the keyboard anywhere. Going through openDiffFor instead would
// pass without the fix, because that path focuses the container itself — the control caught exactly that.
test("closing the bar on a file change hands the keyboard to the content, not to nothing", async () => {
  const { html: two } = await makeReviewHtml([
    { path: "src/first.ts", before: "export const value = 1;\n", after: "export const value = 2;\n" },
    { path: "src/second.ts", before: "export const other = 1;\n", after: "export const other = 3;\n" },
  ]);
  const v = await loadViewer(two);
  await v.openDiffFor("src/first.ts");

  v.key("f", { metaKey: true, code: "KeyF" });
  await v.typeChars(v.$("#file-find-input"), "value");
  assert.equal(v.document.activeElement, v.$("#file-find-input"), "the field owns the keyboard");

  v.window.showOnlyFile("src/second.ts");
  v.window.__kakapoFileFind.refresh();
  await v.settle(140);

  assert.ok(v.$("#file-find").classList.contains("hidden"), "the bar still ends with its file");
  assert.notEqual(v.document.activeElement, v.document.body, "the keyboard did not fall to the document");
  assert.equal(
    v.document.activeElement,
    v.$("#diff2html-container"),
    "it went to the surface the reviewer is now looking at",
  );
  v.close();
});

// ---- IntelliJ's find-toolbar toggles -------------------------------------------------------------
// Cc / W / .* / Search In Selection, the four the editor find bar carries. Each is asserted by what it
// changes about the match set, which is the only thing a toggle is for.

const OPTIONS_FILE = [
  {
    path: "src/opt.ts",
    before: "const nothing = 0;\n",
    after: [
      "const needle = 1;",        // 0
      "const Needle = 2;",        // 1
      "const needleish = 3;",     // 2
      "const other = 'needle';",  // 3
      "",
    ].join("\n"),
  },
];

async function openOptionsFind() {
  const { html: page } = await makeReviewHtml(OPTIONS_FILE);
  const v = await loadViewer(page);
  await v.openSourceFile("src/opt.ts");
  v.key("f", { metaKey: true, code: "KeyF" });
  return v;
}

test("find in file with Match Case off finds both spellings, and on finds only the one typed", async () => {
  const v = await openOptionsFind();
  await v.typeChars(v.$("#file-find-input"), "needle");
  const api = v.window.__kakapoFileFind;
  assert.equal(api.results().length, 4, "needle, Needle, needleish and the string");

  api.toggle("matchCase");
  await v.settle(140);
  assert.equal(api.options().matchCase, true);
  assert.equal(api.results().length, 3, "Needle is a different spelling now");
  assert.ok(api.results().every((hit) => hit.text === "needle"));
  assert.equal(v.$("#file-find-match-case").getAttribute("aria-pressed"), "true");
  v.close();
});

test("find in file with Words on skips a match inside a longer identifier", async () => {
  const v = await openOptionsFind();
  await v.typeChars(v.$("#file-find-input"), "needle");
  const api = v.window.__kakapoFileFind;

  api.toggle("wholeWords");
  await v.settle(140);
  assert.equal(api.results().length, 3, "needleish is not the word needle");
  assert.ok(!api.results().some((hit) => hit.lineIndex === 2));
  v.close();
});

test("find in file with Regex on searches by pattern, with the match's own length", async () => {
  const v = await openOptionsFind();
  const api = v.window.__kakapoFileFind;
  api.toggle("regex");
  await v.typeChars(v.$("#file-find-input"), "need(le)+");
  await v.settle(140);

  assert.equal(api.results().length, 4);
  assert.ok(api.results().every((hit) => hit.length === 6 && hit.text.toLowerCase() === "needle"));
  v.close();
});

test("find in file with Regex and Words on wraps the whole pattern", async () => {
  const v = await openOptionsFind();
  const api = v.window.__kakapoFileFind;
  api.toggle("regex");
  api.toggle("wholeWords");
  await v.typeChars(v.$("#file-find-input"), "needle|nothing");
  await v.settle(140);

  // \b(?:needle|nothing)\b — the alternation as a whole, which is what IntelliJ wraps. Were only the first
  // branch wrapped, needleish would come back as a match for the bare `nothing` branch's side.
  assert.equal(api.results().length, 3);
  assert.ok(!api.results().some((hit) => hit.lineIndex === 2), "needleish is still not a whole word");
  v.close();
});

test("find in file with a toggle pressed re-runs the query without retyping it", async () => {
  const v = await openOptionsFind();
  await v.typeChars(v.$("#file-find-input"), "needle");
  const api = v.window.__kakapoFileFind;
  assert.equal(api.results().length, 4);

  api.toggle("matchCase");
  await v.settle(140);
  assert.equal(api.results().length, 3, "the count moved on the press alone");
  assert.equal(v.$("#file-find-input").value, "needle", "and the query is still in the field");
  v.close();
});

// "No results" for a typo in a pattern is the wrong answer, and the one a reviewer would believe.
// IntelliJ says Bad pattern (find.incorrect.regexp); Find in Files here already did, the find bar did not.
test("an invalid regex says Bad pattern instead of reporting no matches", async () => {
  const v = await openOptionsFind();
  const api = v.window.__kakapoFileFind;
  api.toggle("regex");
  await v.typeChars(v.$("#file-find-input"), "need(le");
  await v.settle(140);

  assert.equal(api.results().length, 0);
  assert.ok(api.options().patternError, "the compiler's complaint was kept");
  assert.equal(v.$("#file-find-count").textContent, "Bad pattern");
  assert.ok(v.$("#file-find-count").classList.contains("is-empty"));

  await v.typeChars(v.$("#file-find-input"), ")");
  assert.equal(api.results().length, 4, "and it recovers when the pattern closes");
  assert.equal(v.$("#file-find-count").textContent, "1/4");
  v.close();
});

function selectSourceLines(v, from, to) {
  const rows = Array.from(v.document.querySelectorAll("#source-body .source-row"));
  const first = rows.find((row) => Number(row.dataset.lineIndex) === from);
  const last = rows.find((row) => Number(row.dataset.lineIndex) === to);
  const range = v.document.createRange();
  range.setStartBefore(first);
  range.setEndAfter(last);
  const selection = v.window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

test("In Selection narrows the search to the selected lines", async () => {
  const { html: page } = await makeReviewHtml(OPTIONS_FILE);
  const v = await loadViewer(page);
  await v.openSourceFile("src/opt.ts");
  selectSourceLines(v, 2, 3);

  v.key("f", { metaKey: true, code: "KeyF" });
  const api = v.window.__kakapoFileFind;
  await v.typeChars(v.$("#file-find-input"), "needle");

  assert.equal(api.options().inSelection, true);
  assert.deepEqual({ ...api.options().selectionLines }, { from: 2, to: 3 });
  assert.equal(api.results().length, 2, "only the two selected lines were searched");
  assert.ok(api.results().every((hit) => hit.lineIndex >= 2 && hit.lineIndex <= 3));

  api.toggle("inSelection");
  await v.settle(140);
  assert.equal(api.results().length, 4, "switching it off gives the file back");
  v.close();
});

// IntelliJ turns it on by itself for a selection spanning more than one line: a reviewer who selected a
// block and reached for find meant that block. A selection inside one line is a word they want to search
// FOR, not a range to search in.
test("In Selection turns itself on only for a selection that spans more than one line", async () => {
  const { html: page } = await makeReviewHtml(OPTIONS_FILE);
  const v = await loadViewer(page);
  await v.openSourceFile("src/opt.ts");
  selectSourceLines(v, 1, 1);

  v.key("f", { metaKey: true, code: "KeyF" });
  assert.equal(v.window.__kakapoFileFind.options().inSelection, false, "one line is a word, not a scope");
  v.key("Escape");
  await v.settle(40);

  selectSourceLines(v, 0, 1);
  v.key("f", { metaKey: true, code: "KeyF" });
  assert.equal(v.window.__kakapoFileFind.options().inSelection, true, "a block is a scope");
  v.close();
});

// The chord, not the function behind it: everything above toggles through the test hook, which would keep
// passing if the keys were never wired. ⌥M/⌥W/⌥X are the rows Find in Files already owns — same chord, same
// meaning, a different surface — and handleFileFindKey sits above the focus guard so they reach the bar
// while its field holds the keyboard.
test("find in file with ⌥M, ⌥W, ⌥X and ⌘⌥E pressed as chords toggles the four", async () => {
  const v = await openOptionsFind();
  const api = v.window.__kakapoFileFind;
  await v.typeChars(v.$("#file-find-input"), "needle");

  v.key("m", { altKey: true, code: "KeyM" });
  await v.settle(140);
  assert.equal(api.options().matchCase, true, "⌥M");
  assert.equal(api.results().length, 3, "and the query re-ran on the chord alone");

  v.key("w", { altKey: true, code: "KeyW" });
  await v.settle(140);
  assert.equal(api.options().wholeWords, true, "⌥W");

  v.key("x", { altKey: true, code: "KeyX" });
  await v.settle(140);
  assert.equal(api.options().regex, true, "⌥X");

  v.key("e", { metaKey: true, altKey: true, code: "KeyE" });
  await v.settle(60);
  assert.equal(api.options().inSelection, false, "⌘⌥E with nothing selected changes no scope");
  v.close();
});

// IntelliJ's Search History, which its toolbar opens as a dropdown from the field. A query enters it when
// the reviewer steps to a match with it (its moveCursor calls addTextToRecent), not on every keystroke.
test("the find field remembers recent searches and ⌥↓ walks back through them", async () => {
  const v = await openOptionsFind();
  const api = v.window.__kakapoFileFind;

  await v.typeChars(v.$("#file-find-input"), "needle");
  v.key("Enter");
  await v.settle(60);
  v.key("Escape");
  await v.settle(60);

  v.key("f", { metaKey: true, code: "KeyF" });
  v.$("#file-find-input").value = "";
  await v.typeChars(v.$("#file-find-input"), "Needle");
  v.key("Enter");
  await v.settle(60);
  // Spread into an array of THIS realm: deepEqual on one read off v.window fails on prototypes alone,
  // and prints two identical-looking arrays while doing it.
  assert.deepEqual([...api.history()], ["Needle", "needle"], "most recent first, no duplicates");

  v.$("#file-find-input").value = "";
  v.key("ArrowDown", { altKey: true, code: "ArrowDown" });
  await v.settle(140);
  assert.equal(v.$("#file-find-input").value, "Needle", "⌥↓ brings the last one back");

  v.key("ArrowDown", { altKey: true, code: "ArrowDown" });
  await v.settle(140);
  assert.equal(v.$("#file-find-input").value, "needle", "and the one before it");

  v.key("ArrowUp", { altKey: true, code: "ArrowUp" });
  await v.settle(140);
  assert.equal(v.$("#file-find-input").value, "Needle", "⌥↑ walks forward again");
  v.close();
});
