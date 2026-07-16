// Reopening with a saved "source" UI state whose sourcePath is blank or points at a now-gone file used to
// restore the tab bar but leave the body on its "select a file" placeholder — a tab visibly open yet the
// pane says to pick a file. Restore must open the first valid tab instead.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeReviewHtml, cleanupFixtures } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";

const UI_KEY = "kakapo-diff-ui:/review.html"; // uiStateKey = 'kakapo-diff-ui:' + location.pathname

let html;
before(async () => {
  ({ html } = await makeReviewHtml([
    { path: "src/app.ts", before: "export const x = 1;\n", after: "export const x = 2;\n" },
    { path: "README.md", before: "# Hi\n", after: "# Hello\n" },
  ]));
});
after(cleanupFixtures);

test("restore: source view + blank sourcePath opens the first tab (no empty body under a visible tab)", async () => {
  const v = await loadViewer(html, {
    seedSession: { [UI_KEY]: JSON.stringify({ view: "source", sourcePath: "", tabs: ["src/app.ts"], hash: "" }) },
  });
  assert.equal(v.visibleView(), "source", "source view restored");
  assert.equal(v.$("#source-viewer").dataset.openPath, "src/app.ts", "the first restored tab was opened");
  assert.equal(v.$("#source-body").classList.contains("empty"), false, "body is painted, not the placeholder");
  assert.ok(v.$('.source-tab[data-tab-path="src/app.ts"]'), "the tab is shown");
  v.close();
});

test("restore: source view + a sourcePath that no longer exists falls back to a valid tab", async () => {
  const v = await loadViewer(html, {
    seedSession: { [UI_KEY]: JSON.stringify({ view: "source", sourcePath: "deleted/gone.ts", tabs: ["deleted/gone.ts", "src/app.ts"], hash: "" }) },
  });
  // gone.ts is filtered out (not in this build); restore should open the surviving tab, not show an empty body.
  assert.equal(v.$("#source-viewer").dataset.openPath, "src/app.ts", "fell back to the surviving tab");
  assert.equal(v.$("#source-body").classList.contains("empty"), false, "body painted");
  v.close();
});
