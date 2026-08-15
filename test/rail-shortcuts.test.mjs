// While the workspace rail is expanded it holds the keyboard, and every shortcut that belongs to the review
// view has to be forwarded to it — the rail collapses, focus goes back, the action runs. ⌘0/⌘1/⌘9/⌃` and F7
// were forwarded; ⌘, was not, so the standard Preferences accelerator simply did nothing whenever the panel
// on the left was open. This pins both ends of that relay, in the two files that have to agree.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const shell = readFileSync(new URL("../src/shell-pages.ts", import.meta.url), "utf8");
const keymap = readFileSync(new URL("../src/viewer/05-keymap.js", import.meta.url), "utf8");

// The handler that only runs while the rail is expanded (`if(!railExp…return`).
const railKeys = shell.match(/document\.addEventListener\('keydown',e=>\{\n {2}if\(!railExp[\s\S]*?\n\}\);/)?.[0];

test("the expanded rail forwards every review shortcut it swallows, including Preferences", () => {
  assert.ok(railKeys, "the rail's keydown handler is findable");
  for (const [name, pattern] of [
    ["Changes", /e\.key==='0'\)fwd='changes'/],
    ["Files", /e\.key==='1'\)fwd='files'/],
    ["History", /e\.key==='9'\)fwd='history'/],
    ["Terminal", /e\.code==='Backquote'\)fwd='terminal'/],
    ["Settings", /e\.key===','\|\|e\.code==='Comma'/],
    ["next change", /railAction\(e\.shiftKey\?'prevChange':'nextChange'\)/],
  ]) {
    assert.match(railKeys, pattern, `${name} is forwarded rather than swallowed`);
  }
});

test("Settings collapses the rail and is sent as a toggle, not as a view to reveal", () => {
  const branch = railKeys.match(/if\(\(e\.metaKey\|\|e\.ctrlKey\)[^}]*Comma[\s\S]*?\n {2}\}/)?.[0];
  assert.ok(branch, "the ⌘, branch exists");
  assert.match(branch, /toggleRail\(\)/, "the rail gets out of the way first, as every other forward does");
  assert.match(branch, /railAction\('settings'\)/, "and the action carries no ':open' — Settings is a modal, not a view");
  assert.doesNotMatch(branch, /settings:open/, "':open' would route it to openRailView, which has no settings view to open");
});

// The other end: an action nothing answers is silently dropped (openRailView's fallback clicks
// `.rail-btn[data-view=…]`, and the settings gear deliberately carries no data-view).
test("the review view answers the forwarded settings action", () => {
  const dispatcher = keymap.match(/onRailAction\(\(action\) => \{[\s\S]*?\n {2}\}\);/)?.[0];
  assert.ok(dispatcher, "the rail-action dispatcher is findable");
  assert.match(dispatcher, /action === 'settings'/, "settings is handled explicitly");
  assert.match(dispatcher, /KeyboardEvent\('keydown', \{ key: ',', metaKey: true/,
    "replayed as the accelerator, so the toggle and the overlay guard in handleSettingsKey stay in one place");
});
