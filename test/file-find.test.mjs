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
