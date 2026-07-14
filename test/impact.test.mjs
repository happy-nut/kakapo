import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { cleanupFixtures, makeReviewHtml } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";

let html;
before(async () => {
  ({ html } = await makeReviewHtml([
    { path: "src/service.ts", before: "export function process() { return 1; }\n", after: "export function process() { return helper(); }\nfunction helper() { return 2; }\n" },
    { path: "src/caller.ts", before: "export const old = 1;\n", after: "import { process } from './service';\nexport const result = process();\n" },
    { path: "test/service.test.ts", before: "export const oldTest = 1;\n", after: "test('process', () => process());\n" },
  ], { app: true }));
});
after(cleanupFixtures);

function analysisResponse(request) {
  assert.equal(request.kind, "impact");
  return {
    ok: true,
    engine: "lsp",
    confidence: "mixed",
    server: "typescript-language-server",
    serverSource: "bundled",
    locations: [{ path: "src/service.ts", lineIndex: 0, column: 16 }],
    impact: {
      symbol: "process",
      callers: [{ path: "src/caller.ts", lineIndex: 1, column: 22, relation: "caller", text: "export const result = process();" }],
      dependencies: [{ path: "src/service.ts", lineIndex: 1, column: 9, name: "helper", relation: "call", text: "function helper() { return 2; }" }],
      implementations: [],
      tests: [{ path: "test/service.test.ts", lineIndex: 0, column: 22, relation: "test", text: "test('process', () => process());" }],
      contracts: [],
    },
  };
}

test("Change Impact rail queries main-process analysis and renders review relationships", async () => {
  const v = await loadViewer(html, { analysisBridge: analysisResponse });
  await v.openSourceFile("src/service.ts");
  v.window.setSourceCursor("src/service.ts", 0, 20, false, -1);
  const rail = v.$('.rail-btn[data-view="impact"]');
  assert.ok(rail, "Electron review renders the Change Impact rail action");
  v.click(rail);
  await v.settle(80);

  assert.equal(v.$("#impact-panel").classList.contains("hidden"), false);
  assert.match(v.$("#impact-engine").textContent, /semantic \+ heuristic · typescript-language-server \(bundled\) · process/);
  assert.match(v.$("#impact-body").textContent, /Callers & importers/);
  assert.match(v.$("#impact-body").textContent, /Related tests/);
  assert.match(v.$("#impact-body").textContent, /src\/caller\.ts:2/);

  v.click(v.$('#impact-body .impact-item[data-impact-index="0"]'));
  await v.settle(50);
  assert.equal(v.$("#source-viewer").dataset.openPath, "src/caller.ts", "impact result opens the exact source file");
  v.close();
});

test("Cmd+8 toggles Change Impact and Cmd+Alt+O opens workspace-symbol search", async () => {
  const v = await loadViewer(html, {
    analysisBridge: (request) => request.kind === "workspaceSymbol"
      ? { ok: true, engine: "index", locations: [{ path: "src/service.ts", lineIndex: 0, column: 16, name: "process" }] }
      : analysisResponse(request),
  });
  await v.openSourceFile("src/service.ts");
  v.key("8", { code: "Digit8", metaKey: true });
  await v.settle(50);
  assert.equal(v.$("#impact-panel").classList.contains("hidden"), false);
  v.key("8", { code: "Digit8", metaKey: true });
  assert.equal(v.$("#impact-panel").classList.contains("hidden"), true);

  v.key("o", { code: "KeyO", metaKey: true, altKey: true });
  await v.settle(180);
  assert.equal(v.quickOpenVisible(), true);
  assert.match(v.$("#quick-open-mode").textContent, /Workspace symbols/);
  assert.match(v.$("#quick-open-results").textContent, /process/);
  v.close();
});
