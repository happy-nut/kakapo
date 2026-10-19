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

  // Each key is its own chip now, the way a system Keyboard pane spells a combination out, so a shortcut is
  // read off its ROW rather than off one element: the chips of a combination join up, and two alternative
  // combinations keep the slash between them.
  const keyNames = v.$all("#settings-modal .keys-row").map((row) =>
    [...row.querySelectorAll(".keys-combo, .keys-or")]
      .map((node) => (node.classList.contains("keys-or") ? " / " : [...node.querySelectorAll("kbd")].map((k) => k.textContent).join("")))
      .join("")
      .replace(/\s+/g, " ")
      .trim());
  // "M" and History's own ⌘A were the overlay's read-only diff pane: expand the commit message, select its
  // diff. That pane is gone — everything opens in the main review now — so the keys it owned went with it.
  for (const key of ["⌘9", "⌘G / ⌘⇧G", "⌘A", "Space", "⌥R", "⌥W"]) {
    assert.ok(keyNames.includes(key), `settings documents ${key}`);
  }

  const text = shortcuts.textContent.replace(/\s+/g, " ");
  for (const label of [
    "Open / close Git history",
    "Next / previous match",
    "Rendered / raw Markdown or CSV",
    "Toggle line wrap",
    "Expand selected diff context",
    "Toggle viewed on selected Changes row",
    "Select a commit, open it in the review",
  ]) {
    assert.match(text, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `settings explains ${label}`);
  }

  v.close();
});
