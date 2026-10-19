// The shortcut table is only worth having if the three things that used to spell a chord separately now
// genuinely read it: the Settings sheet, the dispatcher, and the `data-keyhint` on the buttons that do the
// same job. Each of those is one test here. The fourth test is the one that would have caught the drift
// that started this — five shortcuts that worked and were documented nowhere.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { before } from "node:test";
import { loadViewer } from "./helpers/dom.mjs";
import { makeReviewHtml, cleanupFixtures } from "./helpers/fixture.mjs";

const { SHORTCUTS } = await import("../dist/shortcuts.js");

let html;
before(async () => {
  ({ html } = await makeReviewHtml([
    { path: "src/app.ts", before: "export const x = 1;\n", after: "export const x = 9;\n" },
  ]));
});
after(cleanupFixtures);

/** Turn a display chord ("⌘⇧F") into the KeyboardEvent a real keyboard would send for it. */
function eventFor(chord) {
  const mods = { metaKey: false, shiftKey: false, altKey: false };
  let rest = chord;
  while (rest && "⌘⇧⌥".includes(rest[0])) {
    if (rest[0] === "⌘") mods.metaKey = true;
    if (rest[0] === "⇧") mods.shiftKey = true;
    if (rest[0] === "⌥") mods.altKey = true;
    rest = rest.slice(1);
  }
  const NAMED = {
    Enter: ["Enter", "Enter"], Esc: ["Escape", "Escape"], Space: [" ", "Space"], Tab: ["Tab", "Tab"],
    Backspace: ["Backspace", "Backspace"], Delete: ["Delete", "Delete"],
    PageUp: ["PageUp", "PageUp"], PageDown: ["PageDown", "PageDown"],
    "↑": ["ArrowUp", "ArrowUp"], "↓": ["ArrowDown", "ArrowDown"],
    "←": ["ArrowLeft", "ArrowLeft"], "→": ["ArrowRight", "ArrowRight"],
  };
  const PUNCT = { ",": "Comma", ".": "Period", "/": "Slash", "'": "Quote", "[": "BracketLeft", "]": "BracketRight" };
  if (NAMED[rest]) return { key: NAMED[rest][0], code: NAMED[rest][1], ...mods };
  if (/^F\d{1,2}$/.test(rest)) return { key: rest, code: rest, ...mods };
  if (/^[A-Za-z]$/.test(rest)) return { key: rest.toLowerCase(), code: `Key${rest.toUpperCase()}`, ...mods };
  if (/^\d$/.test(rest)) return { key: rest, code: `Digit${rest}`, ...mods };
  if (PUNCT[rest]) return { key: rest, code: PUNCT[rest], ...mods };
  return null; // a multi-key display like "←↑↓→", which is a description of four keys, not one chord
}

test("every combination in the table resolves to the action it is written against", async () => {
  const v = await loadViewer(html);
  const w = v.window;

  const unmatched = [];
  const misrouted = [];
  for (const def of SHORTCUTS) {
    def.keys.forEach((chord, index) => {
      const init = eventFor(chord);
      if (!init) return; // a description of several keys, not one combination
      // A chord may be offered to several actions — ⌥Enter is row actions, run-request and the merged
      // comment menu, each on its own surface — so what is asserted is that this action is among them.
      const hits = w.shortcutHits(new w.KeyboardEvent("keydown", init));
      if (!hits.length) { unmatched.push(`${def.id} ${chord}`); return; }
      if (!hits.some((h) => h.id === def.id && h.index === index)) {
        misrouted.push(`${def.id}[${index}] ${chord} -> ${hits.map((h) => `${h.id}[${h.index}]`).join(", ")}`);
      }
    });
  }
  assert.deepEqual(unmatched, [], "every combination is recognised");
  assert.deepEqual(misrouted, [], "and recognised as the action it belongs to");
  v.close();
});

test("a keypress actually runs the action, not just resolves to it", async () => {
  const v = await loadViewer(html);
  const w = v.window;

  // Drive each dispatched shortcut through the real document listener and record which action ran. The
  // actions themselves are replaced so the assertion is about routing, not about what each one does —
  // that is what every other test in the suite is for.
  const ran = [];
  const real = w.SHORTCUT_ACTIONS;
  const stub = {};
  for (const id of Object.keys(real)) stub[id] = (event, i) => { ran.push(`${id}[${i}]`); };
  w.SHORTCUT_ACTIONS = stub;

  const expected = [];
  const dispatched = Object.keys(real);
  for (const def of SHORTCUTS) {
    if (!dispatched.includes(def.id)) continue;
    def.keys.forEach((chord, index) => {
      const init = eventFor(chord);
      if (!init) return;
      expected.push(`${def.id}[${index}]`);
      v.key(init.key, init);
    });
  }
  w.SHORTCUT_ACTIONS = real;

  assert.deepEqual(ran.join("\n"), expected.join("\n"), "every dispatched shortcut reaches its action, once");
});

test("the Settings sheet is the table, and documents every shortcut that exists", async () => {
  const v = await loadViewer(html);

  const rows = v.$all("#settings-modal .keys-row");
  const shown = rows.map((r) => r.dataset.shortcut);
  const inTable = SHORTCUTS.map((s) => s.id);
  assert.deepEqual(inTable.filter((id) => !shown.includes(id)), [], "no shortcut exists without a row");
  assert.deepEqual([...new Set(shown)].filter((id) => !inTable.includes(id)), [], "and no row invents one");

  // The row's keys are the table's keys — this is the join that used to be two hand-written copies.
  for (const def of SHORTCUTS) {
    const row = rows.find((r) => r.dataset.shortcut === def.id);
    const chips = [...row.querySelectorAll(".keys-combo")]
      .map((c) => [...c.querySelectorAll("kbd")].map((k) => k.textContent).join(""));
    assert.deepEqual(chips, def.keys, `${def.id} shows the combinations the table gives it`);
  }

  // A row that cannot be rebound says why, so the rebinding UI can refuse the click with a reason.
  const fixed = rows.filter((r) => r.dataset.fixed).map((r) => r.dataset.fixed);
  assert.deepEqual([...new Set(fixed)].sort(), ["menu", "structural"], "the only two reasons a key is fixed");
  v.close();
});

test("a button's data-keyhint comes from the table, so a rebind cannot leave it lying", async () => {
  const v = await loadViewer(html);

  // Every control that advertises a shortcut names the id it advertises; the hint text itself is filled in
  // from the table at render time. Before this, the attribute was a literal typed beside the chord.
  const hinted = v.$all("[data-keyhint-id]");
  assert.ok(hinted.length >= 8, `controls advertise shortcuts by id (found ${hinted.length})`);
  for (const el of hinted) {
    const [id, index] = el.dataset.keyhintId.split(":"); // "filesChangesTab:1" picks one half of a pair
    const def = SHORTCUTS.find((s) => s.id === id);
    assert.ok(def, `${id} is a real shortcut`);
    const chord = def.keys[Number(index || 0)];
    assert.ok(chord, `${el.dataset.keyhintId} names a combination the action has`);
    assert.equal(el.dataset.keyhint, chord, `${el.dataset.keyhintId}'s hint is the table's combination`);
  }
  v.close();
});

test("no two actions on the same surface want the same combination", () => {
  const taken = new Map();
  const clashes = [];
  for (const def of SHORTCUTS) {
    for (const chord of def.keys) {
      for (const scope of def.where === "any" ? ["any"] : ["any", def.where]) {
        const key = `${scope} ${chord}`;
        const holder = taken.get(key);
        if (holder && holder !== def.id) clashes.push(`${chord}: ${holder} vs ${def.id}`);
      }
      taken.set(`${def.where} ${chord}`, def.id);
      if (def.where === "any") {
        for (const surface of ["code", "tree", "merged", "history", "find"]) taken.set(`${surface} ${chord}`, def.id);
      }
    }
  }
  assert.deepEqual(clashes, [], "a combination means one thing per surface");
});

test("the README's shortcut table has not drifted from the real keymap", () => {
  const known = new Set(SHORTCUTS.flatMap((s) => s.keys));
  for (const readme of ["../README.md", "../README_KR.md"]) {
    const text = readFileSync(new URL(readme, import.meta.url), "utf8");
    // Only the rows of the shortcut table — prose mentions a key in a sentence and may abbreviate.
    const cells = [...text.matchAll(/^\| `([⌘⌥⇧][^`]*)`(?: \/ `([^`]*)`)? \|/gm)].flatMap((m) => [m[1], m[2]]);
    const unknown = cells.filter((c) => c && !known.has(c));
    assert.deepEqual(unknown, [], `${readme} documents only shortcuts that exist`);
  }
});
