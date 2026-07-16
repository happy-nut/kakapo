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
      origin: { path: "src/service.ts", lineIndex: 0, column: 16 },
      callers: [{ path: "src/caller.ts", lineIndex: 1, column: 22, relation: "caller", evidence: "semantic", text: "export const result = process();" }],
      dependencies: [{ path: "src/service.ts", lineIndex: 1, column: 9, name: "helper", relation: "call", evidence: "heuristic", text: "function helper() { return 2; }" }],
      implementations: [],
      tests: [{ path: "test/service.test.ts", lineIndex: 0, column: 22, relation: "test", evidence: "semantic", text: "test('process', () => process());" }],
      contracts: [],
      mentions: [],
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
  assert.match(v.$("#impact-engine").textContent, /Targetprocesssrc\/service\.ts:1/);
  assert.match(v.$("#impact-engine").textContent, /typescript-language-server \(bundled\)/);
  assert.match(v.$("#impact-body").textContent, /Confirmed impact/);
  assert.match(v.$("#impact-body").textContent, /Review candidates/);
  assert.match(v.$("#impact-body").textContent, /Callers & importers/);
  assert.match(v.$("#impact-body").textContent, /Related tests/);
  assert.match(v.$("#impact-body").textContent, /src\/caller\.ts:2/);
  assert.ok(v.$('.impact-tier-confirmed .impact-item[data-impact-index="0"]'), "semantic references are separated as confirmed impact");
  assert.ok(v.$('.impact-tier-candidates .impact-item'), "regex-derived dependencies stay review candidates");
  assert.equal(v.document.activeElement, v.$('.impact-tier-confirmed .impact-item'), "the first result owns keyboard focus");

  const active = v.document.activeElement;
  active.dispatchEvent(new v.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
  assert.equal(v.document.activeElement, v.$all('.impact-nav')[1], "ArrowDown moves through impact results");
  v.document.activeElement.dispatchEvent(new v.window.KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true }));
  v.document.activeElement.dispatchEvent(new v.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await v.settle(50);
  assert.equal(v.$("#impact-panel").classList.contains("hidden"), true, "opening a result reveals code instead of leaving the overlay in front");
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
