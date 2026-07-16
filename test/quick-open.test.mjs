// CORE USER FLOW: double-Shift opens the quick-open (file search). The sequence must require TWO Shifts in
// a row — any keystroke between them cancels it. Guards the regression where "Shift → type → Shift" within
// 300ms still popped the search, so it fired on nearly every other keystroke (maddening while typing).
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
