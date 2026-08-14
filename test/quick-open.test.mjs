// CORE USER FLOW: double-Shift opens the quick-open (file search). The sequence must require TWO Shifts in
// a row — any keystroke between them cancels it. Guards the regression where "Shift → type → Shift" within
// 300ms still popped the search, so it fired on nearly every other keystroke (maddening while typing).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeReviewHtml, cleanupFixtures } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";
import { readFileSync } from "node:fs";

let html;
before(async () => {
  ({ html } = await makeReviewHtml([
    { path: "src/a.ts", before: "export const a = 1;\n", after: "export const a = 2;\n" },
  ]));
});
after(cleanupFixtures);

test("double-Shift (same side, in quick succession) opens quick-open", async () => {
  const v = await loadViewer(html);
  v.key("Shift", { location: 1 });
  v.key("Shift", { location: 1 });
  await v.settle(10);
  assert.ok(v.quickOpenVisible(), "Shift Shift opened quick-open");
  v.close();
});

test("a plain keystroke between the two Shifts cancels quick-open", async () => {
  const v = await loadViewer(html);
  v.key("Shift", { location: 1 });
  v.key("k"); // a stray keystroke between the Shifts
  v.key("Shift", { location: 1 });
  await v.settle(10);
  assert.equal(v.quickOpenVisible(), false, "the in-between key cancelled the double-Shift sequence");
  v.close();
});

test("an arrow key between the two Shifts also cancels it", async () => {
  const v = await loadViewer(html);
  v.key("Shift", { location: 1 });
  v.key("ArrowDown"); // arrows are swallowed by the caret handlers — the reset must run before them
  v.key("Shift", { location: 1 });
  await v.settle(10);
  assert.equal(v.quickOpenVisible(), false, "arrow between Shifts cancelled the sequence");
  v.close();
});

test("two Shifts on DIFFERENT sides do not open quick-open", async () => {
  const v = await loadViewer(html);
  v.key("Shift", { location: 1 }); // left
  v.key("Shift", { location: 2 }); // right
  await v.settle(10);
  assert.equal(v.quickOpenVisible(), false, "left+right Shift must not trigger");
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

  v.key("Shift", { location: 1 });
  v.key("Shift", { location: 1 });
  await v.settle(20);
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

// Recent files (Cmd/Ctrl+E) is just the latest files — no search box. IntelliJ-style speed search: typed
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

  v.key("e", { metaKey: true }); // Cmd/Ctrl+E → Recent files
  await v.settle(20);
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

test("Cmd+E opens the Recent panel and a second Cmd+E toggles it closed", async () => {
  const v = await loadViewer(html);
  v.key("e", { metaKey: true, code: "KeyE" });
  await v.settle(10);
  assert.ok(v.quickOpenVisible(), "Cmd+E opened Quick Open (Recent)");
  v.key("e", { metaKey: true, code: "KeyE" }); // second press should toggle it closed, not re-open it
  await v.settle(10);
  assert.equal(v.quickOpenVisible(), false, "a second Cmd+E closed the Recent panel");
  v.close();
});

// REGRESSION: typing in the terminal, Cmd+E dropped the Recent-files dialog over the shell — and quick-open
// is a modal keyboard scope, so from then on it swallowed every key until dismissed. Panel-focused keys
// belong to the panel; the shortcuts deliberately placed above the keymap's focus guard are unaffected.
test("terminal focus: Cmd+E belongs to the shell, not to the Recent-files dialog", async () => {
  // The terminal only exists in the Electron layout, so this case needs an app-mode fixture.
  const { html: appHtml } = await makeReviewHtml([
    { path: "src/a.ts", before: "export const a = 1;\n", after: "export const a = 2;\n" },
  ], { app: true });
  const v = await loadViewer(appHtml);
  const panel = v.$("#terminal-panel");
  assert.ok(panel, "the app layout has a terminal panel");
  panel.classList.remove("hidden");
  const shellInput = v.document.createElement("textarea"); // stands in for xterm's focused helper textarea
  panel.appendChild(shellInput);
  shellInput.focus();

  v.key("e", { metaKey: true, code: "KeyE" });
  await v.settle(20);
  assert.equal(v.quickOpenVisible(), false, "no dialog opens over a shell that is being typed into");

  // Focus back in the review content and the shortcut works exactly as before.
  shellInput.blur();
  v.document.body.focus();
  v.key("e", { metaKey: true, code: "KeyE" });
  await v.settle(20);
  assert.equal(v.quickOpenVisible(), true, "Cmd+E still opens Recent files from the review");
  v.close();
});

// The launcher's section rail is part of the keyboard flow, not a mouse-only strip: ArrowLeft steps into it,
// the arrows move within it, Enter picks, and ArrowRight hands the keyboard back to the results.
test("the launcher rail is reachable and navigable by keyboard", async () => {
  const { html: appHtml } = await makeReviewHtml([
    { path: "src/a.ts", before: "export const a = 1;\n", after: "export const a = 2;\n" },
  ], { app: true });
  const v = await loadViewer(appHtml);

  v.key("e", { metaKey: true, code: "KeyE" });
  await v.settle(20);
  assert.equal(v.quickOpenVisible(), true, "the launcher opens");

  v.key("ArrowLeft");
  await v.settle(10);
  const focused = () => v.document.activeElement?.dataset?.section;
  assert.equal(focused(), "recent", "ArrowLeft lands on the section that is showing");

  v.key("ArrowDown");
  await v.settle(10);
  assert.equal(focused(), "prompts", "ArrowDown steps down the rail");

  v.key("ArrowUp");
  await v.settle(10);
  assert.equal(focused(), "recent", "and ArrowUp steps back");

  v.key("ArrowRight");
  await v.settle(10);
  assert.notEqual(focused(), "recent", "ArrowRight gives the keyboard back to the results");

  // Enter on a rail section picks it and HANDS THE KEYBOARD to that section's panel — the rail keeps focus
  // only while you are still choosing (the arrows). It used to stay on the rail after Enter, which left the
  // pick looking unfinished: the section on the right was showing but the keyboard was still on the left.
  v.key("ArrowLeft"); await v.settle(10);
  v.key("ArrowDown"); await v.settle(10);
  v.key("Enter"); await v.settle(40);
  assert.equal(v.$("#quick-open-mode").textContent, "Prompts", "Enter switches to the focused section");
  assert.equal(focused(), undefined, "and the rail gives the keyboard up, exactly as a mouse pick does");
  v.close();
});

// REGRESSION, and the reason Cmd+Shift+E and even the space bar stopped working: quick-open is a modal
// keyboard scope (every key goes to it, menu accelerators are suspended while it is up) with no
// outside-click dismissal — and the terminal panel renders ABOVE it. Opening a terminal over an open
// launcher therefore left an invisible dialog owning the keyboard: letters and spaces went into its
// speed-search instead of the shell, and every accelerator stayed dead until it was dismissed.
test("the launcher cannot keep the keyboard once it is not the thing on screen", async () => {
  const { html: appHtml } = await makeReviewHtml([
    { path: "src/a.ts", before: "export const a = 1;\n", after: "export const a = 2;\n" },
  ], { app: true });
  const v = await loadViewer(appHtml);

  v.key("e", { metaKey: true, code: "KeyE" });
  await v.settle(20);
  assert.equal(v.quickOpenVisible(), true, "the launcher is up");

  // A click anywhere outside its own panel dismisses it.
  v.document.body.dispatchEvent(new v.window.MouseEvent("mousedown", { bubbles: true }));
  await v.settle(20);
  assert.equal(v.quickOpenVisible(), false, "an outside click closes it");

  // And the terminal, which paints over it, closes it as it opens.
  const client = readFileSync(new URL("../src/viewer/19-terminal.js", import.meta.url), "utf8");
  assert.match(client, /quickOpen && !quickOpen\.classList\.contains\('hidden'\)\) closeQuickOpen\(\)/,
    "opening the terminal dismisses a launcher it would cover");
  v.close();
});

// Picking a prompt is a choice between two or three of them, so the card has to answer "which one do I
// want", not "what does it say". The text is long, editable in Settings, and shaped the same in every
// prompt — leading with its first line made the list impossible to choose from. Tab crosses from the
// section rail to the cards, where the arrows select and Enter sends the one you picked to the terminal.
test("prompts are pickable cards that say when to use them", async () => {
  const { html: appHtml } = await makeReviewHtml([
    { path: "src/a.ts", before: "export const a = 1;\n", after: "export const a = 2;\n" },
  ], { app: true });
  const v = await loadViewer(appHtml);
  const sent = [];
  v.window.__kakapoTerminal = { enterSendMode: (text) => sent.push(text) };

  v.key("P", { metaKey: true, shiftKey: true, code: "KeyP" });
  await v.settle(30);
  const cards = v.$all("#quick-open-results .quick-open-prompt");
  assert.equal(cards.length, 2, "both prompts render as cards");
  const when = cards[0].querySelector(".quick-open-prompt-when");
  assert.ok(when && when.textContent.trim(), "the card says when to reach for it");
  assert.doesNotMatch(cards[0].textContent, /NOTES_PATH|JSON/,
    "and not what the prompt says — that is Settings' job");

  // Tab from the rail hands the keyboard to the cards; arrows pick; Enter sends.
  v.key("ArrowLeft");
  await v.settle(10);
  assert.ok(v.document.activeElement?.dataset?.section, "the rail has the keyboard");
  v.key("Tab");
  await v.settle(10);
  assert.ok(!v.document.activeElement?.dataset?.section, "Tab hands it to the cards");

  v.key("ArrowDown");
  await v.settle(10);
  assert.ok(v.$all("#quick-open-results .quick-open-prompt")[1].classList.contains("active"),
    "the arrows move the selection through the cards");
  // A prompt has no file behind it, so the preview pane must stay out of the way — it was rendering the
  // prompt's id as though it were a path, which read as a stray filename under the cards.
  assert.equal(v.$("#quick-open-preview").innerHTML, "", "no file preview for a prompt");

  v.key("Enter");
  await v.settle(20);
  assert.equal(sent.length, 1, "Enter sends the selected prompt to the terminal");
  assert.match(sent[0], /codebase|저장소|repository/i, "the one that was selected, not the first");
  v.close();
});

// One surface at a time. The launcher covers the whole view, so a terminal left open underneath it is a
// shell you are still typing into but cannot see — it gets put away when the launcher opens, and the rail
// carries a Terminal row that brings it straight back.
test("opening the launcher puts the terminal away, and the rail can bring it back", async () => {
  const { html: appHtml } = await makeReviewHtml([
    { path: "src/a.ts", before: "export const a = 1;\n", after: "export const a = 2;\n" },
  ], { app: true });
  const v = await loadViewer(appHtml);

  let closed = 0;
  let toggled = 0;
  v.window.__kakapoTerminal = { isOpen: () => true, close: () => { closed += 1; } };
  v.$("#terminal-toggle")?.addEventListener("click", () => { toggled += 1; });

  v.key("e", { metaKey: true, code: "KeyE" });
  await v.settle(20);
  assert.equal(closed, 1, "the terminal is put away as the launcher comes up");

  const terminalRow = v.$('#quick-open-side .quick-open-side-item[data-section="terminal"]');
  assert.ok(terminalRow, "the rail lists the terminal");
  assert.equal(terminalRow.dataset.keyhint, "⌃`", "with the shortcut that also opens it");
  v.click(terminalRow);
  await v.settle(20);
  assert.equal(v.quickOpenVisible(), false, "picking it closes the launcher");
  assert.equal(toggled, 1, "and brings the terminal back through its own toggle");
  v.close();
});
