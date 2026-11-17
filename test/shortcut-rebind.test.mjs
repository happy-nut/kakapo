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

function openSheet(v) {
  v.$("#settings-modal").classList.remove("hidden");
}
function rebind(v, id, index, init) {
  openSheet(v);
  const combo = rowFor(v, id).querySelectorAll(".keys-combo")[index];
  v.click(combo);
  v.document.dispatchEvent(new v.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
}

test("a rebound key drives the dispatcher, the sheet and the tooltips together", async () => {
  const v = await loadViewer(html);
  const w = v.window;

  assert.deepEqual(chipsOf(rowFor(v, "openHistory")), ["⌘9"], "it starts on the table's default");

  rebind(v, "openHistory", 0, { key: "j", code: "KeyJ", metaKey: true, altKey: true });

  assert.deepEqual(chipsOf(rowFor(v, "openHistory")), ["⌘⌥J"], "the row shows the new combination");
  assert.ok(rowFor(v, "openHistory").classList.contains("keys-row-custom"), "and is marked as changed");

  const hitNew = w.shortcutHit(new w.KeyboardEvent("keydown", { key: "j", code: "KeyJ", metaKey: true, altKey: true }));
  assert.equal(hitNew?.id, "openHistory", "the new combination reaches the action");
  const hitOld = w.shortcutHit(new w.KeyboardEvent("keydown", { key: "9", code: "Digit9", metaKey: true }));
  assert.equal(hitOld, null, "and the old one no longer does");

  const hinted = v.$all('[data-keyhint-id="openHistory"]');
  assert.ok(hinted.length >= 1, "something advertises this shortcut");
  for (const el of hinted) assert.equal(el.dataset.keyhint, "⌘⌥J", "its hint followed the rebind");

  v.close();
});

test("a combination another action already holds is refused, and says which", async () => {
  const v = await loadViewer(html);

  rebind(v, "openHistory", 0, { key: "b", code: "KeyB", metaKey: true });

  const row = rowFor(v, "openHistory");
  assert.ok(row.classList.contains("keys-row-capturing"), "the row keeps listening");
  const note = row.querySelector(".keys-note");
  assert.ok(note?.classList.contains("keys-note-bad"), "and says no");
  assert.match(note.textContent, /⌘B/, "naming the combination");
  assert.match(note.textContent, /usages/i, "and the action that already has it");
  assert.equal(v.window.shortcutKeys("openHistory").join(), "⌘9", "nothing was stored");

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

  rebind(v, "openHistory", 0, { key: "j", code: "KeyJ", metaKey: true, altKey: true });
  rebind(v, "goToDef", 0, { key: "u", code: "KeyU", metaKey: true, altKey: true });
  assert.deepEqual(chipsOf(rowFor(v, "openHistory")), ["⌘⌥J"]);
  assert.deepEqual(chipsOf(rowFor(v, "goToDef")), ["⌘⌥U", "⌘↓"]);

  v.click(rowFor(v, "openHistory").querySelector(".keys-reset"));
  assert.deepEqual(chipsOf(rowFor(v, "openHistory")), ["⌘9"], "that row is back to the default");
  assert.deepEqual(chipsOf(rowFor(v, "goToDef")), ["⌘⌥U", "⌘↓"], "the other one is untouched");

  v.click(v.$("#settings-kbd-reset-all"));
  assert.deepEqual(chipsOf(rowFor(v, "goToDef")), ["⌘B", "⌘↓"], "and reset-all puts every row back");
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

test("a chord the menu bar eats is refused, so a dead binding cannot be saved", async () => {
  const v = await loadViewer(html);
  for (const [chord, init] of [
    ["⌘O", { key: "o", code: "KeyO", metaKey: true }],
    ["⌘0", { key: "0", code: "Digit0", metaKey: true }],
    ["⌘⇧W", { key: "W", code: "KeyW", metaKey: true, shiftKey: true }],
  ]) {
    rebind(v, "openHistory", 0, init);
    const note = rowFor(v, "openHistory").querySelector(".keys-note");
    assert.ok(note?.classList.contains("keys-note-bad"), `${chord} is turned away`);
    assert.match(note.textContent, /menu/i, `${chord}'s refusal says who owns it`);
    assert.equal(v.window.shortcutKeys("openHistory").join(), "⌘9", `${chord} was not stored`);
    v.document.dispatchEvent(new v.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  }
  v.close();
});

test("a row cannot be rebound onto its own other combination", async () => {
  const v = await loadViewer(html);
  assert.deepEqual(chipsOf(rowFor(v, "compareMode")), ["⌥A", "⌥U", "⌥T", "⌥N"], "the row starts with four");

  rebind(v, "compareMode", 1, { key: "a", code: "KeyA", altKey: true });
  const note = rowFor(v, "compareMode").querySelector(".keys-note");
  assert.ok(note?.classList.contains("keys-note-bad"), "refused");
  assert.match(note.textContent, /⌥A/, "naming the combination");
  assert.deepEqual(Array.from(v.window.shortcutKeys("compareMode")), ["⌥A", "⌥U", "⌥T", "⌥N"], "every combination survives");

  v.document.dispatchEvent(new v.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  rebind(v, "compareMode", 1, { key: "j", code: "KeyJ", metaKey: true, altKey: true });
  assert.deepEqual(Array.from(v.window.shortcutKeys("compareMode")), ["⌥A", "⌘⌥J", "⌥T", "⌥N"], "a free chord is accepted");
  v.close();
});

test("the menu-owned list the page uses matches this platform", async () => {
  const { MENU_OWNED_CHORDS, MENU_OWNED_CHORDS_MAC } = await import("../dist/shortcuts.js");
  const v = await loadViewer(html);
  const inPage = Array.from(v.window.MENU_OWNED_CHORDS);
  for (const chord of MENU_OWNED_CHORDS) {
    assert.ok(inPage.includes(chord), `${chord} is refused on every platform`);
  }
  const ua = v.window.navigator.userAgent;
  const hasMacMenu = /Electron/.test(ua) && /Mac|iPhone|iPad/.test(ua);
  for (const chord of MENU_OWNED_CHORDS_MAC) {
    assert.equal(inPage.includes(chord), hasMacMenu, `${chord} is refused only where macOS's menu holds it`);
  }
  v.close();
});

test("the menu-shortcut hold is counted, so one owner cannot release another's", async () => {
  const v = await loadViewer(html);
  const asked = [];
  v.window.kakapoApp = Object.assign({}, v.window.kakapoApp, {
    setIgnoreMenuShortcuts: (ignore) => asked.push(ignore),
  });

  v.window.holdMenuShortcuts(true);
  assert.deepEqual(asked, [true], "the first hold reaches main");
  v.window.holdMenuShortcuts(true);
  assert.deepEqual(asked, [true], "a second hold is not a second message");
  v.window.holdMenuShortcuts(false);
  assert.deepEqual(asked, [true], "...and releasing it does NOT hand the menu back");
  v.window.holdMenuShortcuts(false);
  assert.deepEqual(asked, [true, false], "the last release hands it back, once");

  v.window.holdMenuShortcuts(false);
  v.window.holdMenuShortcuts(true);
  assert.deepEqual(asked, [true, false, true], "an extra release does not bank a credit");
  v.close();
});

test("hiding the sheet ends a live capture instead of leaving it swallowing keys", async () => {
  const v = await loadViewer(html);
  openSheet(v);
  v.click(rowFor(v, "openHistory").querySelectorAll(".keys-combo")[0]);
  assert.ok(rowFor(v, "openHistory").classList.contains("keys-row-capturing"), "the row is listening");

  v.$("#settings-modal").classList.add("hidden");
  v.document.dispatchEvent(new v.window.KeyboardEvent("keydown",
    { bubbles: true, cancelable: true, key: "j", code: "KeyJ", metaKey: true, altKey: true }));

  assert.equal(v.window.shortcutKeys("openHistory").join(), "⌘9", "no stray chord was bound");
  assert.ok(!v.$(".keys-row-capturing"), "and nothing is still listening");
  v.close();
});
