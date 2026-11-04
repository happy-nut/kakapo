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

// Settings says `aria-modal="true"`, which tells assistive technology that everything outside it is
// inert — and Tab went out there anyway, because opening the sheet only removed `hidden` and left focus
// on <body>. The dialog is the eighth child of <body>, so a keyboard reader had to walk the whole file
// tree and the diff to reach a dialog their screen reader had already told them was the only thing on
// screen. `trapTabWithin` was wired to it the whole time and never ran once: its listener is on the
// modal, so a key pressed while focus is outside never arrives.
test("opening settings puts focus inside it, which is what makes its tab trap real", async () => {
  const { html } = await makeReviewHtml([
    { path: "src/app.ts", before: "export const n = 1;\n", after: "export const n = 2;\n" },
  ]);
  const v = await loadViewer(html);
  try {
    const modal = v.$("#settings-modal");
    assert.equal(modal.getAttribute("aria-modal"), "true", "the premise: it claims to be a modal");
    assert.ok(modal.classList.contains("hidden"), "and starts closed");

    v.$("#app-info-btn").dispatchEvent(new v.window.MouseEvent("click", { bubbles: true }));
    await v.settle(20);

    assert.ok(!modal.classList.contains("hidden"), "it opened");
    assert.ok(modal.contains(v.window.document.activeElement),
      `focus is inside it, not on ${v.window.document.activeElement.tagName}`);

    // And the trap it has always had now has something to hold. Tab at the last control wraps to the
    // first rather than walking out into the tree behind the dialog.
    const stops = v.$all("#settings-modal button, #settings-modal [tabindex='0'], #settings-modal input, #settings-modal select, #settings-modal textarea");
    assert.ok(stops.length > 1, `the sheet has focusable controls (${stops.length})`);
    stops[stops.length - 1].focus();
    modal.dispatchEvent(new v.window.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    await v.settle(10);
    assert.ok(modal.contains(v.window.document.activeElement), "Tab at the end stays in the dialog");
  } finally {
    v.close();
  }
});

test("opening the sheet from the keyboard lands in it, not on its close button", async () => {
  // Reported from use: "open settings with the shortcut and focus goes to the close button, so its tooltip
  // is showing." It did, every time. The focus target was picked with
  // `querySelector('.settings-cat.active, .settings-cat, #settings-close')`, which reads as a preference
  // order and is not one: a selector LIST returns the first match in document order, and `#settings-close`
  // is written before the category buttons. So the × always won — and because it advertises its chord
  // (data-keyhint-id="closeDialog"), focusing it popped the keyhint tooltip, which is what made a quiet
  // mis-focus look like a stuck tooltip.
  const { html } = await makeReviewHtml([
    { path: "src/app.ts", before: "export const n = 1;\n", after: "export const n = 2;\n" },
  ]);
  const v = await loadViewer(html);
  const modal = v.$("#settings-modal");
  assert.ok(modal.classList.contains("hidden"), "the sheet starts closed");

  v.document.dispatchEvent(new v.window.KeyboardEvent("keydown", { key: ",", code: "Comma", metaKey: true, bubbles: true, cancelable: true }));
  await v.settle(30);
  assert.ok(!modal.classList.contains("hidden"), "⌘, opened it");

  const focused = v.document.activeElement;
  assert.ok(modal.contains(focused), "focus went into the sheet");
  assert.notEqual(focused.id, "settings-close", "and not onto the close button");
  assert.ok(focused.classList.contains("settings-cat"), "it lands on a category, where reading starts");
  // The tooltip is the symptom the report named, so assert the symptom too: nothing should be showing.
  const hint = v.$(".mc-keyhint");
  assert.ok(!hint || !hint.classList.contains("show"), "no keyhint tooltip is hanging off the sheet");
  v.close();
});
