import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeReviewHtml, cleanupFixtures } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";

let html;
before(async () => {
  ({ html } = await makeReviewHtml([
    { path: "pnpm-workspace.yaml", before: undefined, after: "packages:\n  - 'packages/*'\n" },
    { path: "packages/ui/package.json", before: undefined, after: JSON.stringify({ name: "@acme/ui" }) },
    { path: "packages/ui/src/Button.ts", before: "export const a = 1;\n", after: "export const a = 2;\n" },
    { path: "packages/ui/verify/button.ts", before: undefined, after: "// a check\n" },
    { path: "packages/data/package.json", before: undefined, after: JSON.stringify({ name: "@acme/data" }) },
    { path: "packages/data/src/store.ts", before: "export const b = 1;\n", after: "export const b = 2;\n" },
    { path: "packages/data/test/store.test.ts", before: undefined, after: "// a test\n" },
  ]));
});
after(cleanupFixtures);

test("the island reaches the page, and a path is classified by what the project declared", async () => {
  const v = await loadViewer(html);
  const layout = v.window.projectLayoutData();
  assert.equal(layout.source, "workspace", "a pnpm-workspace.yaml is the source of the module list");
  // Array.from re-creates the list in THIS realm: anything read off `v.window` carries jsdom's own
  // prototypes, and deepEqual compares those too.
  assert.deepEqual(Array.from(layout.modules, (module) => module.name).sort(), ["@acme/data", "@acme/ui"]);

  assert.equal(v.window.projectModuleName("packages/ui/src/Button.ts"), "@acme/ui");
  assert.equal(v.window.projectModuleName("packages/data/src/store.ts"), "@acme/data");
  assert.equal(v.window.projectHasModules(), true, "two modules is worth a header");

  assert.equal(v.window.projectScopeOf("packages/data/test/store.test.ts"), "test");
  assert.equal(v.window.projectScopeOf("packages/ui/src/Button.ts"), "production");
  v.close();
});

test("a declared test root no convention would guess is still a test root", async () => {
  const v = await loadViewer(html);
  assert.equal(v.window.projectScopeOf("packages/ui/verify/button.ts"), "production");
  assert.equal(v.window.semanticTestPath("packages/data/test/store.test.ts"), true);
  assert.equal(v.window.semanticTestPath("packages/ui/src/Button.ts"), false);
  assert.equal(v.window.projectScopeOf("dist/bundle.min.js"), "generated", "build output is not production code");
  v.close();
});

test("a single-module repo gets no module division at all", async () => {
  const { html: plain } = await makeReviewHtml([
    { path: "src/index.ts", before: "export const a = 1;\n", after: "export const a = 2;\n" },
  ]);
  const v = await loadViewer(plain);
  assert.equal(v.window.projectLayoutData().source, "conventions");
  assert.equal(v.window.projectHasModules(), false);
  v.close();
});

test("a library file is a library file as soon as it says so, cached answer or not", async () => {
  const v = await loadViewer(html);
  await v.settle(20);
  const path = "node_modules/@acme/dep/index.d.ts";
  assert.equal(v.window.projectScopeOf(path), "generated", "with no record, the conventions answer");
  // `sourceByPath` is a top-level `let`, which lives in the script scope and never reaches `window`.
  // Global eval sees that binding; this is how the app itself registers a library record.
  v.window.eval(`sourceByPath.set(${JSON.stringify(path)}, { path: ${JSON.stringify(path)}, library: true, embedded: true, content: "export {};" })`);
  assert.equal(v.window.projectScopeOf(path), "library", "and the record wins the moment it exists");
  v.close();
});
