// The shortcut coach (28-shortcut-coach.js): repeated mouse use of a control that carries a
// data-keyhint raises a top-right nudge naming the key; a chord that WAS used but slept ≥21 days is
// re-introduced at most 3 times. Both sides join on the same canonical "⌘2" spelling — the click side
// reads it off the attribute, the keyboard side rebuilds it from the keydown event.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { cleanupFixtures, makeReviewHtml } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";

const COACH_KEY = "kakapo-shortcut-coach";
const DAY = 24 * 60 * 60 * 1000;

let html;
before(async () => {
  ({ html } = await makeReviewHtml([
    { path: "src/one.ts", before: "const a = 1;\n", after: "const a = 2;\n" },
  ]));
});
after(cleanupFixtures);

test("3 clicks on a keyhint control raise the nudge; pressing the chord ends it and marks the key known", async () => {
  const v = await loadViewer(html);
  const toggle = v.$("#diff-sidebar-toggle"); // data-keyhint="⌘2"
  const nudge = v.$("#coach-nudge");
  assert.ok(toggle && nudge);

  for (let i = 0; i < 2; i += 1) v.click(toggle);
  assert.ok(nudge.classList.contains("hidden"), "2 clicks stay quiet");
  v.click(toggle);
  assert.ok(!nudge.classList.contains("hidden"), "3rd click nudges");
  assert.ok(!nudge.classList.contains("coach-rusty"), "behavior nudge, not the rusty styling");
  assert.equal(v.$("#coach-nudge .coach-keys").textContent, "⌘2");

  v.key("2", { metaKey: true, code: "Digit2" });
  assert.equal(v.$("#coach-nudge .coach-obs").textContent, v.window.t("coach.known"));
  const entry = v.window.__kakapoCoach.ledger["⌘2"];
  assert.ok(entry.uses >= 1, "the chord press was recorded");
  assert.equal(entry.nudges, 0, "using the key refills the reminder budget");

  // Known keys are never nudged again through clicks.
  for (let i = 0; i < 6; i += 1) v.click(toggle);
  assert.equal(entry.clicks, 0);
  v.close();
});

test("a used-then-forgotten chord is re-introduced, and a spent 3/3 budget stays silent", async () => {
  const seed = {
    "⌘2": { uses: 3, last: Date.now() - 30 * DAY, clicks: 0, nudges: 0, nt: 0, muted: false, label: "" },
    "⌘9": { uses: 9, last: Date.now() - 90 * DAY, clicks: 0, nudges: 3, nt: 0, muted: false, label: "History" },
  };
  const v = await loadViewer(html, { seedStorage: { [COACH_KEY]: JSON.stringify(seed) } });
  const nudge = v.$("#coach-nudge");

  v.window.__kakapoCoach.scan();
  assert.ok(!nudge.classList.contains("hidden"), "the sleeping chord is re-introduced");
  assert.ok(nudge.classList.contains("coach-rusty"));
  // ⌘9 slept longer but its 3-reminder budget is spent — ⌘2 is the one picked.
  assert.equal(v.$("#coach-nudge .coach-keys").textContent, "⌘2");
  assert.equal(v.window.__kakapoCoach.ledger["⌘2"].nudges, 1);

  // One rusty nudge per session, and the label resolved from the live DOM (the seed carried none).
  assert.ok(v.$("#coach-nudge .coach-label").textContent.length > 0);
  v.click(v.$("#coach-nudge .coach-ok"));
  assert.ok(nudge.classList.contains("hidden"));
  v.window.__kakapoCoach.scan();
  assert.ok(nudge.classList.contains("hidden"), "second scan in the same session stays quiet");
  v.close();
});

test("'don't show again' mutes the chord for good", async () => {
  const seed = { "⌘2": { uses: 2, last: Date.now() - 40 * DAY, clicks: 0, nudges: 1, nt: 0, muted: false, label: "" } };
  const v = await loadViewer(html, { seedStorage: { [COACH_KEY]: JSON.stringify(seed) } });
  v.window.__kakapoCoach.scan();
  v.click(v.$("#coach-nudge .coach-mute-btn"));
  assert.equal(v.window.__kakapoCoach.ledger["⌘2"].muted, true);
  const saved = JSON.parse(v.window.localStorage.getItem(COACH_KEY));
  assert.equal(saved["⌘2"].muted, true, "the mute is persisted");
  v.close();
});

// The join key. The click side reads a chord off a data-keyhint, which the TABLE wrote; the keyboard side
// rebuilds one from a keydown. If those two spellings differ the ledger silently holds two entries for one
// chord, and the coach teaches a key it has already recorded as used — which is what it did for ⇧⌥W,
// ⌘⇧⌥M, ⌘⇧Backspace and ⌘Enter, because the keyboard side ordered modifiers ⌘⌥⇧ and renamed Enter to ↵.
test("the table spells its modifiers in the coach's canonical order", async () => {
  const { SHORTCUTS } = await import("../dist/shortcuts.js");
  const v = await loadViewer(html);
  const canonical = v.window.__kakapoCoach.canonical;
  // Only the modifier PREFIX has to match. The key's own name may be the short display spelling — the
  // find bar's two buttons are "↵" and "⇧↵" in a strip one line tall — because the normalizer folds
  // ↵/⏎ and Del/⌫ onto one name before the ledger ever sees them. Modifier ORDER is the thing nothing
  // folds: ⌘⌥⇧M and ⌘⇧⌥M are two ledger entries for one chord, which is what this guards.
  const mods = (chord) => (chord.match(/^[⌘⇧⌥⌃]+/) || [""])[0];
  const drifted = SHORTCUTS.flatMap((row) => row.keys)
    .filter((chord) => mods(chord).length > 1 && mods(canonical(chord)) !== mods(chord));
  assert.deepEqual(drifted, [], `these table chords order their modifiers differently: ${drifted.join(" ")}`);
  v.close();
});

test("a display spelling and a keydown of the same key fold onto one ledger name", async () => {
  const v = await loadViewer(html);
  const canonical = v.window.__kakapoCoach.canonical;
  assert.equal(canonical("⇧↵"), canonical("⇧Enter"));
  assert.equal(canonical("⌘⇧Del"), canonical("⌘⇧Backspace"));
  assert.equal(canonical("⌘⏎"), canonical("⌘Enter"));
  // ...and a chord that is only modifiers is left exactly as written (Search Everywhere's double tap).
  assert.equal(canonical("⇧⇧"), "⇧⇧");
  v.close();
});

test("a chord pressed and the same chord clicked land on one ledger entry", async () => {
  const v = await loadViewer(html);
  const ledger = v.window.__kakapoCoach.ledger;
  // The two spellings the keyboard side used to invent, and the table's spelling for each.
  v.key("Backspace", { metaKey: true, shiftKey: true, code: "Backspace" });
  v.key("m", { metaKey: true, shiftKey: true, altKey: true, code: "KeyM" });
  v.key("w", { shiftKey: true, altKey: true, code: "KeyW" });
  v.key("Enter", { metaKey: true, code: "Enter" });
  for (const chord of ["⌘⇧Backspace", "⌘⇧⌥M", "⇧⌥W", "⌘Enter"]) {
    assert.ok(ledger[chord] && ledger[chord].uses >= 1, `${chord} was not recorded under the table's spelling`);
  }
  assert.equal(Object.keys(ledger).filter((k) => /Del|↵|⌥⇧|⌘⌥⇧/.test(k)).length, 0, "no entry under an old spelling");
  v.close();
});
