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

test("Code mode mounts Monaco and returning to Review preserves line comments", async () => {
  const v = await loadViewer(html, {
    monacoBridge: true,
    analysisBridge: (request) => responseFor(request),
    analysisStatus: { generation: 7, phase: "ready", server: "typescript-language-server", updatedAt: new Date(0).toISOString() },
  });
  await v.openSourceFile("src/app.ts");

  const toggle = v.$("#editor-mode-toggle");
  assert.ok(toggle && !toggle.classList.contains("hidden"), "Code mode is offered for analyzable source");
  assert.equal(toggle.textContent, "Code");
  v.click(toggle);
  await v.settle(30);

  assert.ok(v.$("#source-body").classList.contains("monaco-source-body"));
  assert.equal(toggle.textContent, "Review");
  assert.equal(v.window.__monacoMock.editors.length, 1, "one virtualized source editor mounted");
  assert.equal(v.window.__monacoMock.editors[0].getModel().uri.path, "/src/app.ts");

  v.window.__monacoMock.editors[0].setPosition({ lineNumber: 2, column: 18 });
  await v.openComposer("q");
  assert.equal(toggle.textContent, "Code", "commenting returns to the review renderer");
  assert.ok(v.visibleComposerInput(), "the normal line-comment composer opens at the preserved caret");
  v.close();
});

test("semantic providers reject stale generations and Peek shows all current results", async () => {
  let responseGeneration = 7;
  const requests = [];
  const v = await loadViewer(html, {
    monacoBridge: true,
    analysisBridge(request) {
      requests.push(request);
      return responseFor(request, responseGeneration);
    },
    analysisStatus: { generation: 7, phase: "ready", server: "typescript-language-server", updatedAt: new Date(0).toISOString() },
  });
  await v.openSourceFile("src/app.ts");
  v.click(v.$("#editor-mode-toggle"));
  await v.settle(30);

  const mock = v.window.__monacoMock;
  const sourceModel = mock.editors[0].getModel();
  const locations = await mock.providers.definition.provideDefinition(
    sourceModel,
    { lineNumber: 1, column: 16 },
    { isCancellationRequested: false },
  );
  assert.equal(locations.length, 2);
  assert.equal(locations[1].uri.path, "/src/target.ts");
  assert.equal(requests[0].kind, "definition");

  v.window.__analysisStatusCb({ generation: 8, phase: "ready", updatedAt: new Date(1).toISOString() });
  responseGeneration = 7;
  const stale = await mock.providers.definition.provideDefinition(
    sourceModel,
    { lineNumber: 1, column: 16 },
    { isCancellationRequested: false },
  );
  assert.equal(stale.length, 0, "an answer from the previous project generation is discarded");

  v.window.openAnalysisUsages("target", responseFor({}, 8).locations, responseFor({}, 8), "references");
  await v.settle(50);
  assert.ok(!v.$("#semantic-peek").classList.contains("hidden"));
  assert.equal(v.$all("#semantic-peek-results .semantic-peek-item").length, 2);
  assert.match(v.$("#semantic-peek-meta").textContent, /typescript-language-server/);
  assert.match(v.$("#semantic-peek-meta").textContent, /g8/);

  v.click(v.$all("#semantic-peek-results .semantic-peek-item")[1]);
  await v.settle(30);
  assert.equal(mock.editors.at(-1).getModel().uri.path, "/src/target.ts", "Peek previews the selected result");
  v.close();
});
