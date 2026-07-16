import { test, after } from "node:test";
import assert from "node:assert/strict";
import { makeReviewHtml, cleanupFixtures } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";

after(cleanupFixtures);

test("settings lists current app, editor, review, and history shortcuts", async () => {
  const { html } = await makeReviewHtml([
    { path: "src/app.ts", before: "export const n = 1;\n", after: "export const n = 2;\n" },
  ]);
  const v = await loadViewer(html);
  const shortcuts = v.$("#settings-modal .app-info-keys");
  assert.ok(shortcuts, "settings contains the shortcut reference");

  const categories = v.$all("#settings-modal .keys-cat").map((node) => node.textContent.trim());
  for (const category of ["App", "Navigation", "Editor", "Review", "History"]) {
    assert.ok(categories.includes(category), `settings exposes the ${category} category`);
  }

  const keyNames = v.$all("#settings-modal .keys-grid kbd").map((node) => node.textContent.replace(/\s+/g, " ").trim());
  for (const key of ["⌘9", "⌘G / ⌘⇧G", "⌘A", "Space", "⌘⇧M", "⇧,", "M"]) {
    assert.ok(keyNames.includes(key), `settings documents ${key}`);
  }

  const text = shortcuts.textContent.replace(/\s+/g, " ");
  for (const label of [
    "Open / close Git history",
    "Next / previous match",
    "Rendered / raw Markdown or CSV",
    "Expand selected diff context",
    "Focus changed files",
    "Show / hide commit message",
  ]) {
    assert.match(text, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `settings explains ${label}`);
  }

  v.close();
});
