import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { cleanupFixtures, makeReviewHtml } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";

let html;
before(async () => {
  ({ html } = await makeReviewHtml([
    {
      path: "src/app.ts",
      before: "export const oldValue = 1;\n",
      after: "export const target = 2;\nexport function read() { return target; }\n",
    },
    {
      path: "src/target.ts",
      before: "export const before = 1;\n",
      after: "export const target = 3;\n",
    },
  ], { app: true }));
});
after(cleanupFixtures);

function responseFor(request, generation = 7) {
  return {
    ok: true,
    kind: request.kind,
    engine: "lsp",
    confidence: "semantic",
    server: "typescript-language-server",
    serverSource: "bundled",
    generation,
    durationMs: 12.5,
    locations: [
      { path: "src/app.ts", lineIndex: 0, column: 13, endColumn: 19, name: "target", text: "export const target = 2;" },
      { path: "src/target.ts", lineIndex: 0, column: 13, endColumn: 19, name: "target", text: "export const target = 3;" },
    ],
  };
}

test("code files expose one Review renderer for navigation and comments", async () => {
  const v = await loadViewer(html, {
    monacoBridge: true,
    analysisBridge: (request) => responseFor(request),
    analysisStatus: { generation: 7, phase: "ready", server: "typescript-language-server", updatedAt: new Date(0).toISOString() },
  });
  await v.openSourceFile("src/app.ts");

  assert.equal(v.$("#editor-mode-toggle"), null, "there is no second editor-mode control");
  assert.equal(v.$("#source-body").classList.contains("monaco-source-body"), false);
  assert.equal(v.window.__monacoMock.editors.length, 0, "opening a code file does not mount a parallel editor");
  assert.equal(v.$all("#source-body .source-row").length, 3, "the Review renderer owns every source line");

  v.window.setSourceCursor("src/app.ts", 1, 18, false, -1);
  await v.openComposer("q");
  assert.ok(v.visibleComposerInput(), "the line-comment composer opens at the Review caret");
  v.close();
});

test("large app sources load on demand into the same Review renderer", async () => {
  const largeContent = Array.from({ length: 1800 }, (_, index) =>
    `export const generatedLine${index} = "${String(index).padStart(4, "0")}-${"x".repeat(110)}";`,
  ).join("\n") + "\n";
  assert.ok(Buffer.byteLength(largeContent) > 220_000, "fixture crosses the former 214.8 KiB ceiling");

  const built = await makeReviewHtml([
    { path: "src/large.ts", before: largeContent, after: largeContent },
    { path: "src/change.ts", before: "export const before = 1;\n", after: "export const after = 2;\n" },
  ], { app: true, lazyLoad: true });
  const largeRecord = built.build.lazySourceFiles.find((file) => file.path === "src/large.ts");
  assert.ok(largeRecord?.embedded, "large text remains available to the app source bridge");
  assert.equal("virtualized" in largeRecord, false, "large text does not carry a second-renderer mode flag");
  assert.equal(largeRecord.skippedReason, undefined);

  const v = await loadViewer(built.html, {
    lazySourceData: JSON.stringify(built.build.lazySourceFiles),
    monacoBridge: true,
    analysisBridge: (request) => responseFor(request),
  });
  await v.openSourceFile("src/large.ts");
  await v.settle(40);

  assert.deepEqual(v.window.__sourceRequests, ["src/large.ts"], "only the opened file crosses IPC");
  assert.equal(v.$("#editor-mode-toggle"), null);
  assert.equal(v.$("#source-body").classList.contains("monaco-source-body"), false);
  assert.equal(v.window.__monacoMock.editors.length, 0, "large sources do not activate a separate code mode");
  assert.equal(v.$all("#source-body .source-row").length, 1801, "the trailing newline remains visible in Review");
  v.close();
});

test("Review live refresh keeps the active source caret in the single renderer", async () => {
  const before = "export const first = 1;\nexport const second = 2;\nexport const third = 3;\n";
  const b1 = await makeReviewHtml([
    { path: "src/live.ts", before, after: before.replace("first = 1", "first = 10") },
  ], { app: true });
  const b2 = await makeReviewHtml([
    { path: "src/live.ts", before, after: before.replace("first = 1", "first = 100") },
  ], { app: true });
  const v = await loadViewer(b1.html, {
    menuBridge: true,
    monacoBridge: true,
    analysisBridge: (request) => responseFor(request),
  });
  await v.openSourceFile("src/live.ts");
  v.window.setSourceCursor("src/live.ts", 1, 8, false, -1);

  await v.pushDiffUpdate(b2.build.update);
  assert.equal(v.window.__monacoMock.editors.length, 0);
  assert.match(v.$("#source-body").textContent, /first = 100/, "the Review surface receives the new source");
  assert.equal(v.$("#source-body .source-row.cursor-line")?.dataset.lineIndex, "1", "the active source line survives refresh");
  assert.ok(v.$("#source-body .code-cursor"), "the caret is restored after refresh");
  v.close();
});

test("the caret-local semantic menu opens its selected source without a second editor", async () => {
  const v = await loadViewer(html, {
    monacoBridge: true,
    analysisBridge(request) { return responseFor(request); },
    analysisStatus: { generation: 7, phase: "ready", server: "typescript-language-server", updatedAt: new Date(0).toISOString() },
  });
  await v.openSourceFile("src/app.ts");
  assert.equal(v.$("#editor-mode-toggle"), null);
  assert.equal(v.window.__monacoMock.editors.length, 0);

  v.key("1", { metaKey: true, code: "Digit1" });
  await v.settle(20); // leave logical focus in the file tree — the semantic menu must still own Enter
  v.window.openAnalysisUsages("target", responseFor({}, 8).locations, responseFor({}, 8), "references");
  await v.settle(50);
  assert.ok(!v.$("#semantic-peek").classList.contains("hidden"));
  assert.equal(v.$all("#semantic-peek-results .semantic-peek-item").length, 2);
  assert.match(v.$("#semantic-peek-meta").textContent, /typescript-language-server/);
  assert.match(v.$("#semantic-peek-meta").textContent, /g8/);
  assert.equal(v.document.activeElement, v.$("#semantic-peek-results"), "the result dropdown owns arrow navigation");
  assert.equal(v.$("#semantic-peek-editor"), null, "Cmd+B does not cover the code with a second preview editor");
  assert.equal(v.window.__monacoMock.editors.length, 0, "opening the dropdown does not create another editor");

  v.key("ArrowDown");
  await v.settle(30);
  assert.equal(v.$("#semantic-peek-results .semantic-peek-item.active")?.dataset.index, "1");
  assert.equal(v.window.__monacoMock.editors.length, 0, "ArrowDown only changes the dropdown selection");

  v.key("Enter");
  await v.settle(50);
  assert.ok(v.$("#semantic-peek").classList.contains("hidden"), "Enter closes the usages popup");
  assert.equal(v.$("#source-viewer").dataset.openPath, "src/target.ts", "Enter opens the selected source location");
  v.close();
});

test("Cmd+B resolves the token at the active diff caret on both working and base panes", async () => {
  const requests = [];
  const v = await loadViewer(html, {
    monacoBridge: true,
    analysisBridge(request) {
      requests.push(request);
      return responseFor(request);
    },
  });
  await v.openDiffFor("src/app.ts");
  const wrapper = v.window.diffWrapperByPath("src/app.ts");

  function placeCaret(side, needle) {
    const rows = v.window.diffRowsOf(v.window.diffSideTable(wrapper, side));
    const rowIndex = rows.findIndex((row) => v.window.diffLineText(row).includes(needle));
    assert.notEqual(rowIndex, -1, `${side} diff contains ${needle}`);
    const text = v.window.diffLineText(rows[rowIndex]);
    const column = text.indexOf(needle) + 1;
    v.window.setDiffCursor("src/app.ts", side, rowIndex, column, false);
    return { row: rows[rowIndex], column: text.indexOf(needle) };
  }

  const working = placeCaret("new", "target");
  v.key("b", { metaKey: true, code: "KeyB" });
  await v.settle(40);
  assert.deepEqual(
    JSON.parse(JSON.stringify(requests.at(-1))),
    {
      kind: "definition",
      symbol: "target",
      path: "src/app.ts",
      line: v.window.diffLineNumber(working.row) - 1,
      column: working.column,
    },
    "the working-tree caret supplies its exact token and source coordinates",
  );
  assert.ok(!v.$("#semantic-peek").classList.contains("hidden"), "multiple definitions open the caret-local result dropdown");
  v.key("Enter");
  await v.settle(40);
  assert.equal(v.$("#source-viewer").dataset.openPath, "src/app.ts", "Enter opens the selected definition from diff navigation");

  await v.openDiffFor("src/app.ts");
  const base = placeCaret("old", "oldValue");
  v.key("b", { metaKey: true, code: "KeyB" });
  await v.settle(40);
  assert.deepEqual(
    JSON.parse(JSON.stringify(requests.at(-1))),
    {
      kind: "definition",
      symbol: "oldValue",
      path: "src/app.ts",
      line: v.window.diffLineNumber(base.row) - 1,
      column: base.column,
    },
    "the base caret remains a valid semantic-navigation origin",
  );
  v.close();
});

test("semantic results show compact white file labels, omit docs/comments, and distinguish tests", async () => {
  const v = await loadViewer(html, { monacoBridge: true, analysisBridge: (request) => responseFor(request) });
  await v.openSourceFile("src/app.ts");
  const locations = [
    { path: "tests/unit/target.test.ts", lineIndex: 8, column: 2, text: "expect(target()).toBeTruthy();" },
    { path: "src/deep/module/target.ts", lineIndex: 41, column: 7, text: "const value = target();" },
    { path: "docs/target.md", lineIndex: 2, column: 0, text: "target is described here" },
    { path: "src/comment.ts", lineIndex: 3, column: 3, text: "// target is intentionally disabled" },
  ];
  v.window.openAnalysisUsages("target", locations, responseFor({}, 8), "references");
  await v.settle(20);

  const items = v.$all("#semantic-peek-results .semantic-peek-item");
  assert.equal(items.length, 2, "documentation and comment-only locations stay out of navigation");
  assert.equal(items[0].querySelector(".semantic-peek-item-path")?.textContent, "target.ts:42", "the visible label is basename:line");
  assert.equal(items[0].title, "src/deep/module/target.ts:42", "the full path remains available as secondary hover detail");
  assert.ok(!items[0].classList.contains("is-test"), "production results remain above test evidence even when the analyzer returns a test first");
  assert.ok(items[1].classList.contains("is-test"), "test code receives the dedicated green result treatment");
  assert.equal(items[1].querySelector(".semantic-peek-item-path")?.textContent, "target.test.ts:9");
  v.close();
});

test("Cmd+B failure shows a short caret hint and does not open an empty result panel", async () => {
  const v = await loadViewer(html, {
    monacoBridge: true,
    analysisBridge(request) {
      return { ...responseFor(request), locations: [] };
    },
    analysisStatus: { generation: 7, phase: "ready", updatedAt: new Date(0).toISOString() },
  });
  await v.openSourceFile("src/app.ts");
  v.window.setSourceCursor("src/app.ts", 1, 26, false, -1); // `return`, which has no definition
  v.key("b", { metaKey: true, code: "KeyB" });
  await v.settle(60);

  const hint = v.$(".mc-caret-hint");
  assert.ok(hint?.classList.contains("show"), "the failure message appears beside the caret");
  assert.match(hint.textContent, /Definition not found.*return/);
  assert.ok(v.$("#semantic-peek").classList.contains("hidden"), "an empty dropdown is never shown");

  await v.settle(2100);
  assert.equal(hint.classList.contains("show"), false, "the caret hint dismisses itself");
  v.close();
});
