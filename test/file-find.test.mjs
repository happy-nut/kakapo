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
  await v.settle(40);

  const api = v.window.__monacoriFileFind;
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
  await v.settle(60);

  const api = v.window.__monacoriFileFind;
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
  await v.settle(30);
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
  await v.settle(40);
  assert.ok(v.$('#source-body .source-row[data-line-index="1"]'), "navigating the match opens its source fold");
  v.key("Escape");

  await v.openDiffFor("src/folded.ts");
  assert.ok(v.$(".mc-import-fold-row"), "the diff import region starts folded too");
  v.key("f", { metaKey: true, code: "KeyF" });
  v.typeInto(v.$("#file-find-input"), "hiddenImport");
  await v.settle(50);
  assert.equal(v.$(".mc-import-fold-row"), null, "diff search restores both import panes before matching");
  assert.equal(v.window.__monacoriFileFind.results().length, 2, "Base and Working tree each contain the import match");
  v.close();
});
