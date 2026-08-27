// The shortcut coach (28-shortcut-coach.js): repeated mouse use of a control that carries a
// data-keyhint raises a top-right nudge naming the key; a chord that WAS used but slept ≥21 days is
// re-introduced at most 3 times. Both sides join on the same canonical "⌘0" spelling — the click side
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
  const toggle = v.$("#diff-sidebar-toggle"); // data-keyhint="⌘0"
  const nudge = v.$("#coach-nudge");
  assert.ok(toggle && nudge);

  for (let i = 0; i < 2; i += 1) v.click(toggle);
  assert.ok(nudge.classList.contains("hidden"), "2 clicks stay quiet");
  v.click(toggle);
  assert.ok(!nudge.classList.contains("hidden"), "3rd click nudges");
  assert.ok(!nudge.classList.contains("coach-rusty"), "behavior nudge, not the rusty styling");
  assert.equal(v.$("#coach-nudge .coach-keys").textContent, "⌘0");

  v.key("0", { metaKey: true, code: "Digit0" });
  assert.equal(v.$("#coach-nudge .coach-obs").textContent, v.window.t("coach.known"));
  const entry = v.window.__kakapoCoach.ledger["⌘0"];
  assert.ok(entry.uses >= 1, "the chord press was recorded");
  assert.equal(entry.nudges, 0, "using the key refills the reminder budget");

  // Known keys are never nudged again through clicks.
  for (let i = 0; i < 6; i += 1) v.click(toggle);
  assert.equal(entry.clicks, 0);
});

test("a used-then-forgotten chord is re-introduced, and a spent 3/3 budget stays silent", async () => {
  const seed = {
    "⌘0": { uses: 3, last: Date.now() - 30 * DAY, clicks: 0, nudges: 0, nt: 0, muted: false, label: "" },
    "⌘9": { uses: 9, last: Date.now() - 90 * DAY, clicks: 0, nudges: 3, nt: 0, muted: false, label: "History" },
  };
  const v = await loadViewer(html, { seedStorage: { [COACH_KEY]: JSON.stringify(seed) } });
  const nudge = v.$("#coach-nudge");

  v.window.__kakapoCoach.scan();
  assert.ok(!nudge.classList.contains("hidden"), "the sleeping chord is re-introduced");
  assert.ok(nudge.classList.contains("coach-rusty"));
  // ⌘9 slept longer but its 3-reminder budget is spent — ⌘0 is the one picked.
  assert.equal(v.$("#coach-nudge .coach-keys").textContent, "⌘0");
  assert.equal(v.window.__kakapoCoach.ledger["⌘0"].nudges, 1);

  // One rusty nudge per session, and the label resolved from the live DOM (the seed carried none).
  assert.ok(v.$("#coach-nudge .coach-label").textContent.length > 0);
  v.click(v.$("#coach-nudge .coach-ok"));
  assert.ok(nudge.classList.contains("hidden"));
  v.window.__kakapoCoach.scan();
  assert.ok(nudge.classList.contains("hidden"), "second scan in the same session stays quiet");
});

test("'don't show again' mutes the chord for good", async () => {
  const seed = { "⌘0": { uses: 2, last: Date.now() - 40 * DAY, clicks: 0, nudges: 1, nt: 0, muted: false, label: "" } };
  const v = await loadViewer(html, { seedStorage: { [COACH_KEY]: JSON.stringify(seed) } });
  v.window.__kakapoCoach.scan();
  v.click(v.$("#coach-nudge .coach-mute-btn"));
  assert.equal(v.window.__kakapoCoach.ledger["⌘0"].muted, true);
  const saved = JSON.parse(v.window.localStorage.getItem(COACH_KEY));
  assert.equal(saved["⌘0"].muted, true, "the mute is persisted");
});
