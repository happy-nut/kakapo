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
/** Open the sheet the way ⌘, does — a chip inside a hidden modal is not a thing anyone can click. */
function openSheet(v) {
  v.$("#settings-modal").classList.remove("hidden");
}
function rebind(v, id, index, init) {
  // A capture stands down when its sheet is not on screen (29-shortcut-rebind.js): a listener that
  // preventDefaults every key with nothing visible is the bug that made the gear button close Settings
  // and leave the keyboard dead. So the sheet has to be up for this to mean anything.
  openSheet(v);
  const combo = rowFor(v, id).querySelectorAll(".keys-combo")[index];
  v.click(combo);
  v.document.dispatchEvent(new v.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
}

test("a rebound key drives the dispatcher, the sheet and the tooltips together", async () => {
  const v = await loadViewer(html);
  const w = v.window;

  assert.deepEqual(chipsOf(rowFor(v, "openHistory")), ["⌘9"], "it starts on the table's default");

  // Any combination the table does not already hold will do — ⌘⌥J is one (⌘⌥B and ⌘⌥O are not).
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

  // Any combination the table does not already hold will do — ⌘⌥J is one (⌘⌥B and ⌘⌥O are not).
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

// A chord the application MENU holds never reaches the page: Electron consumes it before any renderer
// keydown runs. The sheet used to accept ⌘M (Minimize), ⌘0 (Actual size) and ⌘⇧Z (Redo) without a word
// and save them, leaving a binding that can never fire and nothing on screen saying why. The list it
// refuses from is `MENU_OWNED_CHORDS`, which test/menu-accelerators.test.mjs checks against the real menu.
test("a chord the menu bar eats is refused, so a dead binding cannot be saved", async () => {
  const v = await loadViewer(html);
  // The platform-independent half of the list. ⌘M / ⌘H / ⌘Q / ⌘⌥H come from macOS-only menu roles and are
  // added to the list in the page from the user agent, which jsdom's is not — so they are checked where
  // the real menu is, in test/menu-accelerators.test.mjs.
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

// A two-combination row could be rebound onto its own other combination: ⌥A on the second half of
// ⌥A / ⌥U stored ["⌥A","⌥A"], rendered "⌥A / ⌥A", and left ⌥U — the only keyboard route to "uncommitted
// changes" — unreachable, because isShortcut matches index 0 first.
test("a row cannot be rebound onto its own other combination", async () => {
  const v = await loadViewer(html);
  assert.deepEqual(chipsOf(rowFor(v, "compareMode")), ["⌥A", "⌥U", "⌥T"], "the row starts with three");

  rebind(v, "compareMode", 1, { key: "a", code: "KeyA", altKey: true }); // ⌥A onto the ⌥U slot
  const note = rowFor(v, "compareMode").querySelector(".keys-note");
  assert.ok(note?.classList.contains("keys-note-bad"), "refused");
  assert.match(note.textContent, /⌥A/, "naming the combination");
  // Array.from: an array read off the jsdom window carries that realm's prototype and deepEqual
  // compares prototypes — the values match and the assertion fails anyway. See test/README.
  assert.deepEqual(Array.from(v.window.shortcutKeys("compareMode")), ["⌥A", "⌥U", "⌥T"], "every combination survives");

  v.document.dispatchEvent(new v.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  // ...and a genuinely free chord in the same slot still works, so the guard is not a blanket refusal.
  rebind(v, "compareMode", 1, { key: "j", code: "KeyJ", metaKey: true, altKey: true });
  assert.deepEqual(Array.from(v.window.shortcutKeys("compareMode")), ["⌥A", "⌘⌥J", "⌥T"], "a free chord is accepted");
  v.close();
});

// The list the page refuses from is assembled at bundle time from two constants and the user agent: the
// chords every platform's menu holds, plus four that only macOS adds. A viewer that applied the macOS
// four everywhere would turn away a Ctrl+H on Linux that would have worked.
test("the menu-owned list the page uses matches this platform", async () => {
  const { MENU_OWNED_CHORDS, MENU_OWNED_CHORDS_MAC } = await import("../dist/shortcuts.js");
  const v = await loadViewer(html);
  const inPage = Array.from(v.window.MENU_OWNED_CHORDS);
  for (const chord of MENU_OWNED_CHORDS) {
    assert.ok(inPage.includes(chord), `${chord} is refused on every platform`);
  }
  // Two conditions, not one: the macOS four are added only where there IS an application menu holding
  // them. A static review opened in a browser (jsdom here) has none.
  const ua = v.window.navigator.userAgent;
  const hasMacMenu = /Electron/.test(ua) && /Mac|iPhone|iPad/.test(ua);
  for (const chord of MENU_OWNED_CHORDS_MAC) {
    assert.equal(inPage.includes(chord), hasMacMenu, `${chord} is refused only where macOS's menu holds it`);
  }
  v.close();
});

// Three surfaces ask the main process to stand the application menu down — the merged dock, Quick Open,
// and a rebind capture — and it used to be one boolean. A capture ending inside an open dock revoked the
// dock's protection, and ⌘Q then quit the app from inside it. Counted, so they can overlap.
test("the menu-shortcut hold is counted, so one owner cannot release another's", async () => {
  const v = await loadViewer(html);
  const asked = [];
  v.window.kakapoApp = Object.assign({}, v.window.kakapoApp, {
    setIgnoreMenuShortcuts: (ignore) => asked.push(ignore),
  });

  v.window.holdMenuShortcuts(true);          // the dock
  assert.deepEqual(asked, [true], "the first hold reaches main");
  v.window.holdMenuShortcuts(true);          // a capture, over the top of it
  assert.deepEqual(asked, [true], "a second hold is not a second message");
  v.window.holdMenuShortcuts(false);         // the capture ends
  assert.deepEqual(asked, [true], "...and releasing it does NOT hand the menu back");
  v.window.holdMenuShortcuts(false);         // the dock closes
  assert.deepEqual(asked, [true, false], "the last release hands it back, once");

  // It cannot go negative and strand the menu off.
  v.window.holdMenuShortcuts(false);
  v.window.holdMenuShortcuts(true);
  assert.deepEqual(asked, [true, false, true], "an extra release does not bank a credit");
  v.close();
});

// Closing the sheet ends a live capture. The × button got this for free by letting its click bubble to
// the document handler; the gear stopPropagation()s its own click and did not — so Settings went away
// with a capture-phase keydown still on, swallowing every key with nothing on screen, and writing the
// next free chord into the overrides for a row nobody could see.
test("hiding the sheet ends a live capture instead of leaving it swallowing keys", async () => {
  const v = await loadViewer(html);
  openSheet(v);
  v.click(rowFor(v, "openHistory").querySelectorAll(".keys-combo")[0]);
  assert.ok(rowFor(v, "openHistory").classList.contains("keys-row-capturing"), "the row is listening");

  // Whatever hid it — the gear, a programmatic close — the next key must not be captured.
  v.$("#settings-modal").classList.add("hidden");
  v.document.dispatchEvent(new v.window.KeyboardEvent("keydown",
    { bubbles: true, cancelable: true, key: "j", code: "KeyJ", metaKey: true, altKey: true }));

  assert.equal(v.window.shortcutKeys("openHistory").join(), "⌘9", "no stray chord was bound");
  assert.ok(!v.$(".keys-row-capturing"), "and nothing is still listening");
  v.close();
});
