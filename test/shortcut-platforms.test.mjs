// The chord table says ⌘ and means "Command OR Control", so every chord in it has to fire from a
// Windows/Linux keypress (ctrlKey) as well as a macOS one (metaKey). That equivalence is asserted nowhere
// else: every other keyboard test in this suite dispatches metaKey, because that is what the machine
// writing them runs.
//
// It also guards the two spellings an event can arrive in. A layout that reports a different `key` for a
// chord still reports the same physical `code`, and the matcher reads both — which is the whole reason
// ⌥-chords work on a Korean layout, where `event.key` for ⌥3 is not "3".
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeReviewHtml, cleanupFixtures } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";

let html;
before(async () => {
  ({ html } = await makeReviewHtml([
    { path: "src/app.ts", before: "export const a = 1;\n", after: "export const a = 2;\n" },
  ]));
});
after(cleanupFixtures);

/**
 * Which actions the matcher says this event is — the same question the dispatcher asks.
 *
 * Spread into THIS realm before comparing: an array that came back from the viewer's window has that
 * window's Array prototype, and assert.deepEqual compares prototypes (it reports "same structure but not
 * reference-equal", which reads like a product bug and is not one).
 */
function hits(v, init) {
  const event = new v.window.KeyboardEvent("keydown", { bubbles: true, ...init });
  return [...v.window.shortcutHits(event)].map((hit) => hit.id);
}

test("every ⌘ chord fires from Control as well as Command", async () => {
  const v = await loadViewer(html);
  // One per modifier shape the new navigation chords use, plus two long-standing ones as controls.
  const chords = [
    { name: "⌘P", init: { key: "p", code: "KeyP" }, expect: "searchFiles" },
    { name: "⌘⇧E", init: { key: "e", code: "KeyE", shiftKey: true }, expect: "recentLocations" },
    { name: "⌘⇧B", init: { key: "b", code: "KeyB", shiftKey: true }, expect: "typeDeclaration" },
    { name: "⌘⇧Y", init: { key: "y", code: "KeyY", shiftKey: true }, expect: "callHierarchy" },
    { name: "⌘⇧H", init: { key: "h", code: "KeyH", shiftKey: true }, expect: "typeHierarchy" },
    { name: "⌘U", init: { key: "u", code: "KeyU" }, expect: "goToSuper" },
    { name: "⌘F3", init: { key: "F3", code: "F3" }, expect: "showBookmarks" },
    { name: "⌘F12", init: { key: "F12", code: "F12" }, expect: "fileStructure" },
    { name: "⌘B", init: { key: "b", code: "KeyB" }, expect: "defUsages" },
    { name: "⌘E", init: { key: "e", code: "KeyE" }, expect: "recentFiles" },
  ];
  for (const chord of chords) {
    const onMac = hits(v, { ...chord.init, metaKey: true });
    const onWindows = hits(v, { ...chord.init, ctrlKey: true });
    assert.ok(onMac.includes(chord.expect), `${chord.name} is ${chord.expect} with Command (got ${onMac.join(", ") || "nothing"})`);
    assert.deepEqual(onWindows, onMac, `${chord.name} means the same thing with Control`);
  }
  v.close();
});

test("the chords with no ⌘ are modifier-exact, so Control does not turn them into something else", async () => {
  const v = await loadViewer(html);
  assert.deepEqual(hits(v, { key: "F3", code: "F3" }), ["toggleBookmark"]);
  assert.deepEqual(hits(v, { key: "3", code: "Digit3", altKey: true }), ["jumpBookmark"]);
  assert.deepEqual(hits(v, { key: "3", code: "Digit3", altKey: true, shiftKey: true }), ["assignBookmark"]);
  // ⌥↓ is deliberately shared: stepping symbols in the code, stepping comments in the merged dock. The
  // table allows one chord to serve several actions when they live on different surfaces, and the
  // dispatcher tries them in turn — so what matters is that they do not share a surface.
  const altDown = hits(v, { key: "ArrowDown", code: "ArrowDown", altKey: true });
  assert.ok(altDown.includes("nextPrevSymbol"), altDown.join(", "));
  const surfaces = altDown.map((id) => [...v.window.SHORTCUT_DEFS].find((def) => def.id === id)?.where);
  assert.equal(new Set(surfaces).size, surfaces.length, `one chord, one surface each (got ${surfaces.join(", ")})`);
  // Adding Control must NOT make ⌥↓ read as a ⌘ chord — ⌘↓ is Go to Definition, and a reader pressing
  // Ctrl+Alt+Down would otherwise jump somewhere entirely different.
  assert.ok(!hits(v, { key: "ArrowDown", code: "ArrowDown", altKey: true, ctrlKey: true }).includes("nextPrevSymbol"));
  v.close();
});

test("a chord is recognised by physical key, so a non-US layout still reaches it", async () => {
  const v = await loadViewer(html);
  // What ⌥3 produces on a Mac US layout is "£"; on other layouts, something else again. The `code` is
  // the same key every time, which is why the matcher reads it first.
  assert.deepEqual(hits(v, { key: "£", code: "Digit3", altKey: true }), ["jumpBookmark"]);
  // And a layout that reports only `key` (no usable `code`) still matches the plain spelling.
  assert.ok(hits(v, { key: "p", code: "", metaKey: true }).includes("searchFiles"));
  v.close();
});

test("the double-tap chord is one chord, counted once per press", async () => {
  const v = await loadViewer(html);
  const shift = () => new v.window.KeyboardEvent("keydown", { key: "Shift", code: "ShiftLeft", shiftKey: true, bubbles: true });
  const first = shift();
  // The dispatcher asks the matcher more than once per event; a counter with a side effect would make one
  // press look like two. Asking the same event twice must give the same answer.
  assert.deepEqual([...v.window.shortcutHits(first)].map((h) => h.id), []);
  assert.deepEqual([...v.window.shortcutHits(first)].map((h) => h.id), [], "the same event is still not a double tap");
  assert.deepEqual([...v.window.shortcutHits(shift())].map((h) => h.id), ["searchEverywhere"]);
  v.close();
});
