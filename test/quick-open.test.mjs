// CORE USER FLOW: reaching the project searches. ⌘⇧F opens Find in Files, and its section rail is the way
// to the file-name search and Recent files. ⌘E is the one direct key, straight to Recent files with no rail
// beside it; double-Shift was removed on request, and the first test holds that line.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeReviewHtml, cleanupFixtures } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";

let html;
before(async () => {
  ({ html } = await makeReviewHtml([
    { path: "src/a.ts", before: "export const a = 1;\n", after: "export const a = 2;\n" },
  ]));
});
after(cleanupFixtures);

test("double-Shift opens nothing; Cmd+E opens Recent files on its own and toggles closed", async () => {
  const v = await loadViewer(html);
  v.key("Shift", { location: 1 });
  v.key("Shift", { location: 1 });
  await v.settle(10);
  assert.equal(v.quickOpenVisible(), false, "double-Shift no longer opens the file search");
  v.key("e", { metaKey: true, code: "KeyE" });
  await v.settle(10);
  assert.ok(v.quickOpenVisible(), "Cmd+E opens Recent files");
  assert.ok(v.$("#quick-open").classList.contains("quick-recent"), "…in the recent-files section");
  assert.equal(
    v.$("#quick-open").classList.contains("quick-launcher"),
    false,
    "…without the section rail: the key already names the section it wants",
  );
  v.key("e", { metaKey: true, code: "KeyE" });
  await v.settle(10);
  assert.equal(v.quickOpenVisible(), false, "a second Cmd+E closes it");
  v.close();
});

test("Cmd+Shift+F reaches every search section through the rail", async () => {
  const v = await loadViewer(html);
  await v.openQuickOpenSection("all");
  assert.ok(v.quickOpenVisible(), "the file-name search is reachable");
  assert.equal(v.$("#quick-open-mode").textContent, "Search files");
  v.key("Escape");
  await v.settle(10);
  await v.openQuickOpenSection("recent");
  assert.ok(v.$("#quick-open").classList.contains("quick-recent"), "so is Recent files");
  v.close();
});

test("file quick-open waits for a query and hydrates the selected lazy preview", async () => {
  const { html: lazyHtml, build } = await makeReviewHtml([
    {
      path: "src/anchor.ts",
      before: "export const anchor = 1;\n",
      after: "export const anchor = 2;\n",
    },
    {
      path: "AGENTS.md",
      before: "# Review rules\n\nTrust but verify every change.\n",
      after: "# Review rules\n\nTrust but verify every change.\n",
    },
  ], { lazyLoad: true });
  const v = await loadViewer(lazyHtml, { lazySourceData: build.lazySourceData });

  await v.openQuickOpenSection("all");
  assert.equal(v.$all("#quick-open-results .quick-open-item").length, 0, "an empty file query does not dump the project file list");
  assert.match(v.$("#quick-open-results").textContent, /Type a file name to search/);
  assert.equal(v.$("#quick-open-preview").textContent, "", "there is no arbitrary preview before a query");
  assert.equal(v.window.getComputedStyle(v.$("#quick-open-preview")).display, "none", "the empty preview area consumes no space");
  assert.equal(v.window.__projectIndexRequests, 0, "opening an untouched search does not load the project index");

  v.typeInto(v.$("#quick-open-input"), "AGENTS");
  await v.settle(180);
  assert.equal(v.window.__projectIndexRequests, 1, "the first real query loads deferred project files once");
  assert.equal(v.$all("#quick-open-results .quick-open-item").length, 1, "the matching file appears after typing");
  assert.deepEqual(v.window.__sourceRequests, ["AGENTS.md"], "preview fetches the selected file body on demand");
  assert.match(v.$("#quick-open-preview").textContent, /Trust but verify every change/, "the hydrated preview shows real file content");

  const row = v.$("#quick-open-results .quick-open-item");
  row.dispatchEvent(new v.window.MouseEvent("mouseover", { bubbles: true }));
  assert.equal(v.$("#mc-button-hint").classList.contains("hidden"), true, "a visible file row is not repeated in a tooltip");
  v.close();
});

// Recent files is just the latest files — no search box. IntelliJ-style speed search: typed
// letters narrow the list in place, Backspace deletes, Esc clears the filter (then closes).
test("Recent files hides the search box and filters by typed letters (speed search)", async () => {
  const { html: multi } = await makeReviewHtml([
    { path: "src/alpha.ts", before: "export const a=1;\n", after: "export const a=2;\n" },
    { path: "src/bravo.ts", before: "export const b=1;\n", after: "export const b=2;\n" },
    { path: "src/charlie.ts", before: "export const c=1;\n", after: "export const c=2;\n" },
  ]);
  const v = await loadViewer(multi);
  const names = () => v.$all("#quick-open-results .quick-open-item .quick-open-name").map((n) => n.textContent);
  await v.openSourceFile("src/charlie.ts");
  await v.openSourceFile("src/bravo.ts");
  await v.openSourceFile("src/alpha.ts");

  await v.openQuickOpenSection("recent");
  assert.ok(v.quickOpenVisible(), "recent opened");
  assert.ok(v.$("#quick-open").classList.contains("quick-recent"), "recent mode marks the overlay");
  assert.equal(v.window.getComputedStyle(v.$("#quick-open-input")).display, "none", "the search box is hidden");
  assert.deepEqual(names().sort(), ["alpha.ts", "bravo.ts", "charlie.ts"], "all recent files listed");

  v.key("b"); v.key("r"); // type-to-filter
  await v.settle(20);
  assert.equal(v.$("#quick-open-filter").textContent, "br", "typed letters show as the live filter");
  assert.deepEqual(names(), ["bravo.ts"], "the list narrows to the match — no search box needed");

  v.key("Backspace"); v.key("Backspace");
  await v.settle(20);
  assert.equal(names().length, 3, "Backspace restores the full recent list");

  v.key("a"); v.key("l"); // re-filter to alpha only, then test the two-stage Esc
  await v.settle(20);
  assert.deepEqual(names(), ["alpha.ts"], "filtered again");
  v.key("Escape");
  await v.settle(10);
  assert.ok(v.quickOpenVisible(), "first Esc clears the filter, does not close");
  assert.equal(names().length, 3, "list restored after the clearing Esc");
  v.key("Escape");
  await v.settle(10);
  assert.equal(v.quickOpenVisible(), false, "second Esc closes");
  v.close();
});

test("Find in Files shows occurrence-level rg results and opens the exact source line", async () => {
  const { html: searchable } = await makeReviewHtml([
    {
      path: "src/search.ts",
      before: "export const oldValue = 1;\n",
      after: "export const first = 'needle';\nexport const second = 'needle';\n",
    },
  ]);
  const requests = [];
  const v = await loadViewer(searchable, {
    searchBridge(request) {
      requests.push(request);
      return {
        available: true,
        engine: "ripgrep",
        truncated: false,
        matches: [
          { path: "src/search.ts", line: 1, column: 23, endColumn: 29, text: "export const first = 'needle';", matchText: "needle" },
          { path: "src/search.ts", line: 2, column: 24, endColumn: 30, text: "export const second = 'needle';", matchText: "needle" },
        ],
      };
    },
  });

  v.key("f", { metaKey: true, shiftKey: true, code: "KeyF" });
  await v.settle(20);
  v.typeInto(v.$("#quick-open-input"), "needle");
  await v.settle(180);

  assert.deepEqual(JSON.parse(JSON.stringify(requests)), [{ query: "needle", limit: 500 }], "the renderer delegates one debounced project search");
  assert.equal(v.$all("#quick-open-results .search-result").length, 2, "each occurrence gets its own result row");
  assert.match(v.$("#quick-open-results .search-result .quick-open-name").textContent, /search\.ts:1:23/);
  assert.equal(v.$("#quick-open-filter").textContent, "2 results · rg");

  v.key("ArrowDown");
  v.key("Enter");
  await v.settle(80);
  assert.equal(v.visibleView(), "source", "opening a search result switches to source");
  assert.equal(v.$("#source-body .source-row.cursor-line")?.dataset.lineIndex, "1", "the second occurrence opens on line 2");
  v.close();
});

test("Find in Files owns shortcuts without hijacking native search-field editing", async () => {
  const { html: searchable } = await makeReviewHtml([
    {
      path: "src/search.ts",
      before: "export const oldValue = 1;\n",
      after: "export const WfaRunDescriptor = 1;\n",
    },
  ]);
  const v = await loadViewer(searchable, {
    searchBridge() {
      return { available: true, engine: "ripgrep", truncated: false, matches: [] };
    },
  });

  await v.openSourceFile("src/search.ts");
  v.key("ArrowRight");
  v.key("ArrowRight");
  await v.settle(30);
  v.key("f", { metaKey: true, shiftKey: true, code: "KeyF" });
  await v.settle(20);

  const input = v.$("#quick-open-input");
  v.typeInto(input, "WfaRunDescriptor");
  input.setSelectionRange(input.value.length, input.value.length);
  v.$("#source-body").classList.remove("mc-panel-focus-flash");
  const shortcut = new v.window.KeyboardEvent("keydown", {
    key: "ArrowLeft",
    code: "ArrowLeft",
    metaKey: true,
    bubbles: true,
    cancelable: true,
  });

  assert.equal(input.dispatchEvent(shortcut), true, "the browser keeps ownership of native Cmd+Left input editing");
  assert.equal(shortcut.defaultPrevented, false, "the modal scope does not cancel the input's native line-edge movement");
  assert.equal(v.document.activeElement, input, "the search field keeps focus");
  assert.equal(v.$("#source-body").classList.contains("mc-panel-focus-flash"), false, "the dimmed source panel is not reactivated");
  assert.ok(v.quickOpenVisible(), "the search panel stays open");
  v.close();
});

test("Find in Files filters extensions and excludes comment and test results with Option shortcuts", async () => {
  const { html: searchable } = await makeReviewHtml([
    { path: "src/main.py", before: "old = 1\n", after: "needle = 1\n# needle comment\n" },
    { path: "src/main.ts", before: "old = 1;\n", after: "const needle = 1;\n" },
    { path: "tests/test_main.py", before: "old = 1\n", after: "needle = 2\n" },
  ]);
  const requests = [];
  const matches = [
    { path: "src/main.py", line: 1, column: 1, endColumn: 7, text: "needle = 1", matchText: "needle" },
    { path: "src/main.py", line: 2, column: 3, endColumn: 9, text: "# needle comment", matchText: "needle" },
    { path: "src/main.ts", line: 1, column: 7, endColumn: 13, text: "const needle = 1;", matchText: "needle" },
    { path: "tests/test_main.py", line: 1, column: 1, endColumn: 7, text: "needle = 2", matchText: "needle" },
  ];
  const v = await loadViewer(searchable, {
    searchBridge(request) {
      requests.push(request);
      return { available: true, engine: "ripgrep", truncated: false, matches };
    },
  });

  v.key("f", { metaKey: true, shiftKey: true, code: "KeyF" });
  v.typeInto(v.$("#quick-open-input"), "needle");
  v.key("e", { altKey: true, code: "KeyE" });
  assert.equal(v.document.activeElement, v.$("#quick-open-extensions"), "Option+E focuses the extension filter");
  v.typeInto(v.$("#quick-open-extensions"), ".py");
  v.key("p", { altKey: true, code: "KeyP" });
  await v.settle(190);

  assert.equal(v.$("#quick-open-exclude-noise").getAttribute("aria-pressed"), "true");
  assert.deepEqual(JSON.parse(JSON.stringify(requests.at(-1))), {
    query: "needle",
    limit: 500,
    extensions: ["py"],
    excludeCommentsAndTests: true,
  });
  assert.deepEqual(
    v.$all("#quick-open-results .search-result .quick-open-name").map((node) => node.textContent),
    ["main.py:1:1"],
    "only the non-comment result in a matching non-test file remains",
  );
  v.close();
});

test("Find in Files falls back locally and returns every occurrence when rg is unavailable", async () => {
  const { html: searchable } = await makeReviewHtml([
    {
      path: "src/fallback.ts",
      before: "export const oldValue = 1;\n",
      after: "const needle = 'needle needle';\n",
    },
  ]);
  const v = await loadViewer(searchable);
  v.key("f", { metaKey: true, shiftKey: true, code: "KeyF" });
  v.typeInto(v.$("#quick-open-input"), "needle");
  await v.settle(180);

  assert.equal(v.$all("#quick-open-results .search-result").length, 3, "declaration plus two string occurrences are separate results");
  assert.equal(v.$("#quick-open-filter").textContent, "3 results · local");
  v.close();
});

test("Find in Files preview incrementally reveals surrounding code while scrolling", async () => {
  const lines = Array.from({ length: 400 }, (_, index) => index === 199 ? "const needle = 200;" : `const line_${index + 1} = ${index + 1};`);
  const { html: searchable } = await makeReviewHtml([
    { path: "src/long.ts", before: lines.join("\n").replace("needle", "oldValue") + "\n", after: lines.join("\n") + "\n" },
  ]);
  const v = await loadViewer(searchable, {
    searchBridge() {
      return {
        available: true,
        engine: "ripgrep",
        truncated: false,
        matches: [{ path: "src/long.ts", line: 200, column: 7, endColumn: 13, text: "const needle = 200;", matchText: "needle" }],
      };
    },
  });

  v.key("f", { metaKey: true, shiftKey: true, code: "KeyF" });
  v.typeInto(v.$("#quick-open-input"), "needle");
  await v.settle(180);
  const preview = v.$("#quick-open-preview");
  const visibleNumbers = () => v.$all("#quick-open-preview .qp-num").map((node) => Number(node.textContent));
  assert.equal(visibleNumbers()[0], 140, "the initial window starts well above the selected line");
  assert.equal(visibleNumbers().at(-1), 260, "the initial window continues well below the selected line");
  assert.equal(v.$("#quick-open-preview .qp-search-hit")?.textContent, "needle", "the selected occurrence is visible and highlighted in preview");

  Object.defineProperties(preview, {
    clientHeight: { configurable: true, value: 200 },
    scrollHeight: {
      configurable: true,
      get() { return v.$all("#quick-open-preview .qp-line").length * 18 + 24; },
    },
  });
  preview.scrollTop = preview.scrollHeight - preview.clientHeight;
  preview.dispatchEvent(new v.window.Event("scroll"));
  await v.settle(40);
  assert.equal(visibleNumbers().at(-1), 380, "scrolling near the edge appends the next surrounding-code chunk");

  const heightBeforePrepend = preview.scrollHeight;
  preview.scrollTop = 0;
  preview.dispatchEvent(new v.window.Event("scroll"));
  await v.settle(40);
  assert.equal(visibleNumbers()[0], 20, "scrolling upward prepends the preceding surrounding-code chunk");
  assert.equal(
    preview.scrollTop,
    preview.scrollHeight - heightBeforePrepend,
    "prepending preserves the visible code anchor instead of jumping to the new first line",
  );
  v.close();
});

// The launcher's section rail is part of the keyboard flow, not a mouse-only strip: ArrowLeft steps into it,
// the arrows move within it, Enter picks, and ArrowRight hands the keyboard back to the results.
test("the launcher rail is reachable and navigable by keyboard", async () => {
  const { html: appHtml } = await makeReviewHtml([
    { path: "src/a.ts", before: "export const a = 1;\n", after: "export const a = 2;\n" },
  ], { app: true });
  const v = await loadViewer(appHtml);

  await v.openQuickOpenSection("recent");
  assert.equal(v.quickOpenVisible(), true, "the launcher opens");

  v.key("ArrowLeft");
  await v.settle(10);
  const focused = () => v.document.activeElement?.dataset?.section;
  assert.equal(focused(), "recent", "ArrowLeft lands on the section that is showing");

  v.key("ArrowDown");
  await v.settle(10);
  assert.equal(focused(), "worktree", "ArrowDown steps down the rail");

  v.key("ArrowUp");
  await v.settle(10);
  assert.equal(focused(), "recent", "and ArrowUp steps back");

  v.key("ArrowRight");
  await v.settle(10);
  assert.notEqual(focused(), "recent", "ArrowRight gives the keyboard back to the results");

  // Enter on a rail section hands the keyboard to that section — the rail keeps focus only while you are
  // still choosing (the arrows). History is a panel of its own, so Enter on it dismisses the launcher
  // entirely; either way the rail does not keep the keyboard.
  v.key("ArrowLeft"); await v.settle(10);
  v.key("ArrowDown"); await v.settle(10); // worktrees
  v.key("ArrowDown"); await v.settle(10); // history
  v.key("Enter"); await v.settle(40);
  assert.equal(focused(), undefined, "the rail gives the keyboard up, exactly as a mouse pick does");
  v.close();
});

// quick-open is a modal keyboard scope: every key goes to it and menu accelerators are suspended while it
// is up. Without a dismissal it can be left owning the keyboard invisibly, with every accelerator dead.
test("the launcher cannot keep the keyboard once it is not the thing on screen", async () => {
  const { html: appHtml } = await makeReviewHtml([
    { path: "src/a.ts", before: "export const a = 1;\n", after: "export const a = 2;\n" },
  ], { app: true });
  const v = await loadViewer(appHtml);

  await v.openQuickOpenSection("recent");
  assert.equal(v.quickOpenVisible(), true, "the launcher is up");

  // A click anywhere outside its own panel dismisses it.
  v.document.body.dispatchEvent(new v.window.MouseEvent("mousedown", { bubbles: true }));
  await v.settle(20);
  assert.equal(v.quickOpenVisible(), false, "an outside click closes it");
  v.close();
});

// ⌘8 is the Worktrees section's own key, the sibling of ⌘9's history. The rows come from the main process,
// so the renderer is exercised here against a stub: what it must get right is asking once, rendering what it
// is handed, and — the case an ordinary single-clone repository hits every time — saying so when the answer
// is just this one checkout.
test("Cmd+8 opens the worktree list, renders what git reports, and toggles closed", async () => {
  const { html: appHtml } = await makeReviewHtml([
    { path: "src/a.ts", before: "export const a = 1;\n", after: "export const a = 2;\n" },
  ], { app: true });
  const v = await loadViewer(appHtml);

  let opened = "";
  let prCalls = 0;
  const LONG = "/Users/dev/repos/app/.claude/worktrees/github-issue-1731-c87b33";
  v.window.kakapoGit = {
    worktrees: async () => [
      { path: "/Users/dev/repos/app", displayPath: "~/repos/app", branch: "main", head: "a".repeat(40), shortHead: "aaaaaaaa", current: true, detached: false, bare: false, locked: false, prunable: false, subject: "root commit", date: "2026-01-02T00:00:00Z", dirty: false },
      { path: LONG, displayPath: "~/repos/…/worktrees/github-issue-1731-c87b33", branch: "claude/entry-cadence-review", head: "b".repeat(40), shortHead: "bbbbbbbb", current: false, detached: false, bare: false, locked: false, prunable: false, subject: "stop the crash", date: "2026-01-03T00:00:00Z", dirty: true, ahead: 2, behind: 1 },
    ],
    worktreePullRequests: async () => { prCalls += 1; return { "claude/entry-cadence-review": { number: 42, title: "Stop the crash", isDraft: false, url: "https://example.test/42" } }; },
    openWorktree: async (path) => { opened = path; return { ok: true }; },
  };

  v.key("8", { metaKey: true, code: "Digit8" });
  await v.settle(40);
  assert.equal(v.quickOpenVisible(), true, "the launcher is up on the worktree section");

  const rows = v.$all("#quick-open-results .quick-open-item");
  assert.equal(rows.length, 2, "one row per checkout");

  // The branch IS the row. It lives in its own element on its own line precisely so a long path can never
  // squeeze it down to an ellipsis, which is what the shared file-row layout did.
  const branches = rows.map((r) => r.querySelector(".wt-branch").textContent);
  assert.deepEqual(branches, ["main", "claude/entry-cadence-review"], "spelled out, not elided");
  assert.ok(rows[0].querySelector(".wt-icon svg"), "each row is marked with what kind of checkout it is");

  // The path gives up its middle so its tail — the part that tells two worktrees apart — survives.
  assert.match(rows[1].querySelector(".wt-path").textContent, /github-issue-1731-c87b33$/);

  // State as marks rather than sentences: the words cost more width than the branch name had. Each keeps
  // its word as the tooltip, so nothing is lost.
  assert.match(rows[1].querySelector(".wt-flags").textContent, /↑2/, "drift ahead of upstream");
  assert.match(rows[1].querySelector(".wt-flags").textContent, /↓1/, "and behind it");
  assert.ok(rows[1].querySelector(".wt-dirty"), "uncommitted work is a mark on the row");
  assert.ok(rows[1].querySelector(".wt-dirty").getAttribute("title"), "…that still says what it means on hover");
  assert.equal(rows[0].querySelector(".wt-dirty"), null, "a clean checkout carries no mark");
  assert.ok(rows[0].classList.contains("is-current"), "the checkout you are in is the one marked without a word");
  assert.match(rows[1].textContent, /stop the crash/, "what that checkout was last doing");

  // The PR badge is a second, independent read: local commits that have since become a pull request say so.
  assert.equal(prCalls, 1);
  assert.equal(rows[1].querySelector(".wt-pr").textContent, "#42", "the open PR behind that branch");
  assert.equal(rows[0].querySelector(".wt-pr"), null, "a branch with no PR carries no badge");

  // Whatever the row had to shorten, the selected row spells out underneath.
  v.key("ArrowDown"); await v.settle(20);
  assert.match(v.$("#quick-open-preview").textContent, /\/Users\/dev\/repos\/app\/\.claude\/worktrees\/github-issue-1731-c87b33/, "the full path, untruncated");
  assert.match(v.$("#quick-open-preview").textContent, /Stop the crash/, "and the PR it belongs to");

  v.key("Enter"); await v.settle(20);
  assert.equal(opened, LONG, "Enter on another checkout opens it");
  assert.equal(v.quickOpenVisible(), false, "and the launcher gets out of the way");

  // Enter on the current checkout is a no-op — it is the window you are already in.
  opened = "";
  v.key("8", { metaKey: true, code: "Digit8" });
  await v.settle(40);
  v.key("Enter"); await v.settle(20);
  assert.equal(opened, "", "the current worktree is not reopened");
  v.close();
});

// A detached checkout has no branch, and the commit sha names nothing a reader recognises. The directory
// these get made in is named after the task, which is how they are actually referred to.
test("a detached worktree is named by its directory, with the commit as a flag", async () => {
  const { html: appHtml } = await makeReviewHtml([
    { path: "src/a.ts", before: "export const a = 1;\n", after: "export const a = 2;\n" },
  ], { app: true });
  const v = await loadViewer(appHtml);
  v.window.kakapoGit = {
    worktrees: async () => [
      { path: "/Users/dev/repos/app/.claude/worktrees/data-audit-2852ee", displayPath: "~/repos/…/worktrees/data-audit-2852ee", branch: "", head: "d".repeat(40), shortHead: "dddddddd", detached: true, current: false, bare: false, locked: false, prunable: false, subject: "audit the data", date: "2026-01-01T00:00:00Z", dirty: false },
      { path: "/Users/dev/repos/app/.claude/worktrees/gone-1666", displayPath: "~/repos/…/worktrees/gone-1666", branch: "", head: "e".repeat(40), shortHead: "eeeeeeee", detached: true, current: false, bare: false, locked: false, prunable: true, subject: "", date: "2025-12-01T00:00:00Z", dirty: false },
    ],
    worktreePullRequests: async () => ({}),
    openWorktree: async () => ({ ok: true }),
  };

  v.key("8", { metaKey: true, code: "Digit8" });
  await v.settle(40);
  const rows = v.$all("#quick-open-results .quick-open-item");
  assert.equal(rows[0].querySelector(".wt-branch").textContent, "data-audit-2852ee", "the task, not the sha");
  assert.equal(rows[0].querySelector(".wt-sha").textContent, "dddddddd", "the sha is still there, as a flag");

  // The icon carries the reason, so the flags do not repeat it — a warning triangle next to a bare "!" said
  // one thing twice and neither of them said which problem it was.
  const warn = rows[1].querySelector(".wt-icon.is-warn");
  assert.ok(warn, "a checkout whose directory is gone is marked as such");
  assert.ok(warn.getAttribute("title"), "and the mark says what it means on hover");
  assert.equal(rows[1].querySelector(".wt-flags").textContent.includes("!"), false, "without repeating itself");
  assert.equal(rows[0].querySelector(".wt-icon.is-warn"), null, "a healthy checkout is not flagged");
  v.close();
});

// Every other repository in the world is a single clone. That answer has to read as an answer, not as a
// list that failed to load.
test("the worktree section says so when there is only this checkout", async () => {
  const { html: appHtml } = await makeReviewHtml([
    { path: "src/a.ts", before: "export const a = 1;\n", after: "export const a = 2;\n" },
  ], { app: true });
  const v = await loadViewer(appHtml);
  v.window.kakapoGit = { worktrees: async () => [], worktreePullRequests: async () => ({}), openWorktree: async () => ({ ok: true }) };

  v.key("8", { metaKey: true, code: "Digit8" });
  await v.settle(40);
  assert.equal(v.$all("#quick-open-results .quick-open-item").length, 0);
  assert.match(v.$("#quick-open-results").textContent, /worktree/i, "an empty state, not an empty box");
  v.close();
});

test("the launcher lists only the surfaces that still exist", async () => {
  const v = await loadViewer(html);
  await v.openQuickOpenSection("content");
  const sections = v.$all("#quick-open-side .quick-open-side-item").map((b) => b.dataset.section);
  assert.deepEqual(sections, ["content", "all", "recent", "worktree", "history"], "the three searches, worktrees and history, nothing removed");
  v.close();
});
