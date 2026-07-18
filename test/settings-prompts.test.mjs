import { test, after } from "node:test";
import assert from "node:assert/strict";
import { makeReviewHtml, cleanupFixtures } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";

after(cleanupFixtures);

async function openPromptSettings(v) {
  v.click(v.$("#app-info-btn"));
  v.click(v.$('.settings-cat[data-cat="prompts"]'));
  await v.settle(0);
}

test("merge prompt settings expose editable effective defaults and persist changes", async () => {
  const { html } = await makeReviewHtml([
    { path: "src/app.ts", before: "export const n = 1;\n", after: "export const n = 2;\n" },
  ]);
  const v = await loadViewer(html);
  await openPromptSettings(v);

  const plan = v.$("#settings-prompt-plan");
  const question = v.$("#settings-prompt-q");
  const change = v.$("#settings-prompt-c");
  assert.equal(plan.value, v.window.defaultMergePrompt("plan"), "the effective plan prompt is editable text");
  assert.equal(question.value, v.window.defaultMergePrompt("q"), "the effective question prompt is editable text");
  assert.equal(change.value, v.window.defaultMergePrompt("c"), "the effective change prompt is editable text");
  assert.equal(change.placeholder, "", "the default is not hidden in a placeholder");
  assert.match(change.value, /human can review independently/, "the default requires human-reviewable work units");

  v.typeInto(change, "custom change-request contract");
  assert.equal(v.$("#settings-saved").textContent, "Saved", "autosave is visibly confirmed");

  v.click(v.$("#app-info-btn")); // close
  await openPromptSettings(v);
  assert.equal(v.$("#settings-prompt-c").value, "custom change-request contract", "the saved value is restored as editable text");

  v.click(v.$("#settings-reset"));
  assert.equal(v.$("#settings-prompt-c").value, v.window.defaultMergePrompt("c"), "reset restores visible default text");
  v.close();
});

test("the generated change-request handoff includes the human-reviewable-unit contract", async () => {
  const { html } = await makeReviewHtml([
    { path: "src/app.ts", before: "export const n = 1;\n", after: "export const n = 2;\n" },
  ]);
  const v = await loadViewer(html);
  v.window.addComment("c", "src/app.ts", 1, "export const n = 2;", "keep this focused");

  const merged = v.window.buildMergedText("c");
  assert.match(merged, /human can review independently/);
  assert.match(merged, /one independently reviewable unit at a time/);
  assert.match(merged, /keep this focused/);
  v.close();
});
