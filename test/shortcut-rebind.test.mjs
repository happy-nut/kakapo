// Rebinding is the thing the table was consolidated for: a chord is a value now, so it can be replaced.
// What has to hold is that replacing it moves everything at once — the dispatcher, the sheet and the
// hint on the button that does the same job — because the whole point was that those three stop being
// separate copies of the same string.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { loadViewer } from "./helpers/dom.mjs";
import { makeReviewHtml, cleanupFixtures } from "./helpers/fixture.mjs";

let html;
before(async () => {
  ({ html } = await makeReviewHtml([
    { path: "src/app.ts", before: "export const x = 1;\n", after: "export const x = 9;\n" },
  ]));
});
after(cleanupFixtures);

const rowFor = (v, id) => v.$(`#settings-modal .keys-row[data-shortcut="${id}"]`);
const chipsOf = (row) => [...row.querySelectorAll(".keys-combo")]
  .map((c) => [...c.querySelectorAll("kbd")].map((k) => k.textContent).join(""));

/** Click a row's nth combination and press `init` at it. */
function rebind(v, id, index, init) {
  const combo = rowFor(v, id).querySelectorAll(".keys-combo")[index];
  v.click(combo);
  v.document.dispatchEvent(new v.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
}

test("a rebound key drives the dispatcher, the sheet and the tooltips together", async () => {
  const v = await loadViewer(html);
  const w = v.window;

  assert.deepEqual(chipsOf(rowFor(v, "openHistory")), ["⌘9"], "it starts on the table's default");

  // Any combination the table does not already hold will do — ⌘⌥J is one (⌘⌥B, ⌘⌥H and ⌘⌥O are not).
  rebind(v, "openHistory", 0, { key: "j", code: "KeyJ", metaKey: true, altKey: true });

  // 1. the sheet
  assert.deepEqual(chipsOf(rowFor(v, "openHistory")), ["⌘⌥J"], "the row shows the new combination");
  assert.ok(rowFor(v, "openHistory").classList.contains("keys-row-custom"), "and is marked as changed");

  // 2. the dispatcher
  const hitNew = w.shortcutHit(new w.KeyboardEvent("keydown", { key: "j", code: "KeyJ", metaKey: true, altKey: true }));
  assert.equal(hitNew?.id, "openHistory", "the new combination reaches the action");
  const hitOld = w.shortcutHit(new w.KeyboardEvent("keydown", { key: "9", code: "Digit9", metaKey: true }));
  assert.equal(hitOld, null, "and the old one no longer does");

  // 3. the hint on every control that advertises the same action
  const hinted = v.$all('[data-keyhint-id="openHistory"]');
  assert.ok(hinted.length >= 1, "something advertises this shortcut");
  for (const el of hinted) assert.equal(el.dataset.keyhint, "⌘⌥J", "its hint followed the rebind");

  v.close();
});

test("a combination another action already holds is refused, and says which", async () => {
  const v = await loadViewer(html);

  rebind(v, "openHistory", 0, { key: "b", code: "KeyB", metaKey: true }); // ⌘B is Find usages

  const row = rowFor(v, "openHistory");
  assert.ok(row.classList.contains("keys-row-capturing"), "the row keeps listening");
  const note = row.querySelector(".keys-note");
  assert.ok(note?.classList.contains("keys-note-bad"), "and says no");
  assert.match(note.textContent, /⌘B/, "naming the combination");
  assert.match(note.textContent, /usages/i, "and the action that already has it");
  assert.equal(v.window.shortcutKeys("openHistory").join(), "⌘9", "nothing was stored");

  // Esc leaves it exactly as it was.
  v.document.dispatchEvent(new v.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  assert.deepEqual(chipsOf(rowFor(v, "openHistory")), ["⌘9"], "cancelling restores the default");
  v.close();
});

test("a bare key is refused — the surfaces below already use those", async () => {
  const v = await loadViewer(html);

  rebind(v, "openHistory", 0, { key: "j", code: "KeyJ" });
  const note = rowFor(v, "openHistory").querySelector(".keys-note");
  assert.ok(note?.classList.contains("keys-note-bad"), "a bare letter is turned away");
  assert.equal(v.window.shortcutKeys("openHistory").join(), "⌘9", "and not stored");

  // A function key needs no modifier — those are not keys any surface types with.
  v.document.dispatchEvent(new v.window.KeyboardEvent("keydown", { key: "F9", code: "F9", bubbles: true, cancelable: true }));
  assert.deepEqual(chipsOf(rowFor(v, "openHistory")), ["F9"], "F9 is accepted on its own");
  v.close();
});

test("a key the page does not own cannot be clicked away", async () => {
  const v = await loadViewer(html);

  for (const [id, reason] of [["closeTab", "menu"], ["closeDialog", "structural"]]) {
    const row = rowFor(v, id);
    assert.equal(row.dataset.fixed, reason, `${id} is fixed, and says why`);
    v.click(row.querySelector(".keys-combo"));
    assert.equal(row.classList.contains("keys-row-capturing"), false, `${id} does not start listening`);
    assert.ok(row.querySelector(".keys-note"), "it explains instead of ignoring the click");
  }
  v.close();
});

test("one row and all rows can be put back", async () => {
  const v = await loadViewer(html);

  // Any combination the table does not already hold will do — ⌘⌥J is one (⌘⌥B, ⌘⌥H and ⌘⌥O are not).
  rebind(v, "openHistory", 0, { key: "j", code: "KeyJ", metaKey: true, altKey: true });
  rebind(v, "defUsages", 0, { key: "u", code: "KeyU", metaKey: true, altKey: true });
  assert.deepEqual(chipsOf(rowFor(v, "openHistory")), ["⌘⌥J"]);
  // defUsages answers to two chords (⌘B and IntelliJ's ⌘⌥F7), and only the one that was rebound moves.
  assert.deepEqual(chipsOf(rowFor(v, "defUsages")), ["⌘⌥U", "⌘⌥F7"]);

  v.click(rowFor(v, "openHistory").querySelector(".keys-reset"));
  assert.deepEqual(chipsOf(rowFor(v, "openHistory")), ["⌘9"], "that row is back to the default");
  assert.deepEqual(chipsOf(rowFor(v, "defUsages")), ["⌘⌥U", "⌘⌥F7"], "the other one is untouched");

  v.click(v.$("#settings-kbd-reset-all"));
  assert.deepEqual(chipsOf(rowFor(v, "defUsages")), ["⌘B", "⌘⌥F7"], "and reset-all puts every row back");
  assert.equal(v.$(".keys-row-custom"), null, "nothing is marked as changed any more");
  v.close();
});

test("the key being typed at a listening row cannot fire the shortcut it is typed at", async () => {
  const v = await loadViewer(html);
  const w = v.window;

  let fired = 0;
  const real = w.SHORTCUT_ACTIONS.findInFiles;
  w.SHORTCUT_ACTIONS.findInFiles = () => { fired += 1; };
  rebind(v, "openHistory", 0, { key: "f", code: "KeyF", metaKey: true, shiftKey: true });
  w.SHORTCUT_ACTIONS.findInFiles = real;

  assert.equal(fired, 0, "⌘⇧F did not open Find in Files while a row was listening for it");
  v.close();
});
