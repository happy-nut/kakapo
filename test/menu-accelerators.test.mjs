import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { SHORTCUTS, electronAcceleratorFor } from "../dist/shortcuts.js";

const require = createRequire(import.meta.url);

// A menu accelerator is consumed before any renderer keydown runs, so a chord the application menu holds
// cannot also be a row in the shortcut table — the row would be advertised in the Settings sheet and in
// both READMEs and never fire. Two rows were in exactly that state and the suite was green throughout,
// because jsdom dispatches keydown straight at the page: ⌘⌥H ran the app menu's Hide Others, and ⌘0 the
// View menu's zoom reset.
//
// The table may hold such a chord in two cases, and only these:
//   - the row says `fixed: "menu"` — it knows the menu owns the key and is documenting it;
//   - the menu item forwards the key to the page (`sendToFocused`), which is how ⌘W and ⌃⌘⇧/ work.
//
// Electron's EDIT roles are forwarding by nature: undo/cut/copy/paste/selectAll act on the focused
// webContents, so the page still gets the effect. Every other role does something to the window or to the
// application instead — hide, hide others, minimize, zoom, quit — and the keystroke never arrives.
//
// Electron reports a built item's role lower-cased ("selectall", "hideothers"), not in the spelling the
// template used, so the comparison is lower-cased too — spelling them in camelCase let ⌘A through as a
// clash the first time this ran.
const FORWARDING_ROLES = new Set(["editmenu", "undo", "redo", "cut", "copy", "paste",
  "pasteandmatchstyle", "delete", "selectall"]);

/**
 * Electron's accelerator spelling in the table's spelling(S) — plural, because one keystroke can be
 * spelled two ways and only one of them would ever be compared. `CommandOrControl+Plus` is Command and
 * the `+` CHARACTER, which on a US layout is Shift and the `=` key: the chord a reader would write as
 * ⌘⇧=. A table row spelled ⌘⇧= would therefore be eaten by the zoom accelerator while matching nothing
 * here. Every shifted-character accelerator has the same shape, so they are expanded, not special-cased.
 *
 * Ctrl folds into ⌘ (the table spells both the same way); modifiers run ⌘⇧⌥.
 */
const SHIFTED = { Plus: ["+", "="], Underscore: ["_", "-"], Colon: [":", ";"], Tilde: ["~", "`"] };
const NAMED = { Plus: "+", Space: "Space", Backspace: "Backspace", Delete: "Delete", Tab: "Tab",
  Return: "Enter", Enter: "Enter", Escape: "Esc", Up: "↑", Down: "↓", Left: "←", Right: "→",
  PageUp: "PageUp", PageDown: "PageDown" };

/** One (modifiers, key) pair in the table's spelling. Never re-joined with "+": the key can BE "+". */
function spell(mods, key) {
  const command = ["CommandOrControl", "CmdOrCtrl", "Command", "Cmd", "Control", "Ctrl", "Super", "Meta"]
    .some((name) => mods.has(name));
  return (command ? "⌘" : "") + (mods.has("Shift") ? "⇧" : "")
    + (mods.has("Alt") || mods.has("Option") ? "⌥" : "")
    + (NAMED[key] ?? (key.length === 1 ? key.toUpperCase() : key));
}

function foldAll(accelerator) {
  const parts = accelerator.split("+");
  const key = parts.pop();
  const mods = new Set(parts);
  const shifted = SHIFTED[key];
  if (!shifted) return [spell(mods, key)];
  const withShift = new Set(mods);
  withShift.add("Shift");
  return [spell(mods, shifted[0]), spell(withShift, shifted[1])];
}

test("no shortcut row sits on a chord the application menu eats", { timeout: 60_000 }, async () => {
  const main = readFileSync(fileURLToPath(new URL("../dist/app-main.js", import.meta.url)), "utf8");

  // The roles the shipped main process actually uses, and whether each forwards.
  const roles = [...new Set([...main.matchAll(/role:\s*"([A-Za-z]+)"/g)].map((m) => m[1]))];
  assert.ok(roles.includes("appMenu"), `the macOS app menu is still built from a role: ${roles.join(", ")}`);

  // Every chord the menus DRAW. app-main puts these on items with registerAccelerator: false, so the
  // risk is not that they steal a key but that Electron cannot PARSE one — which throws inside
  // buildFromTemplate and would take the whole menu bar with it. They are built for real below.
  const drawn = [...new Set(SHORTCUTS.flatMap((row) => row.keys.map((_key, index) => electronAcceleratorFor(row.id, index))))]
    .filter(Boolean);

  const electron = require("electron");
  const fixture = fileURLToPath(new URL("./fixtures/electron-menu-accelerators.cjs", import.meta.url));
  const result = await new Promise((resolve, reject) => {
    const child = spawn(electron, [fixture, JSON.stringify(roles), JSON.stringify(drawn)], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const marker = result.stdout.split(/\r?\n/).find((line) => line.startsWith("KAKAPO_MENU_ACCELERATORS="));
  assert.ok(marker, `menu accelerators missing\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  const fromRoles = JSON.parse(marker.slice("KAKAPO_MENU_ACCELERATORS=".length));

  // Hide Others is the one this test exists for: it is a chord no source file in the repo mentions.
  const eaten = new Map();                                   // folded chord -> what holds it
  for (const item of fromRoles) {
    if (item.role && FORWARDING_ROLES.has(item.role.toLowerCase())) continue;
    for (const chord of foldAll(item.accelerator)) eaten.set(chord, `the ${item.role || item.label} menu item (${item.accelerator})`);
  }
  assert.ok(eaten.has("⌘⌥H"), "role: appMenu still binds Hide Others to ⌘⌥H");

  // The hand-written items: non-forwarding unless their click sends the key on to the page.
  for (const m of main.matchAll(/accelerator:\s*"([^"]+)"/g)) {
    const around = main.slice(Math.max(0, m.index - 320), m.index + 320);
    if (around.includes("sendToFocused")) continue;
    for (const chord of foldAll(m[1])) eaten.set(chord, `a menu item that does not forward it (${m[1]})`);
  }

  // The zoom-in item is the reason foldAll exists: it must be known under BOTH of its spellings.
  assert.ok(eaten.has("⌘+") && eaten.has("⌘⇧="),
    "CommandOrControl+Plus is one keystroke with two spellings and both must be claimed");

  const drawnMarker = result.stdout.split(/\r?\n/).find((line) => line.startsWith("KAKAPO_MENU_DRAWN="));
  assert.ok(drawnMarker, `drawn accelerators missing\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  const drawnBack = JSON.parse(drawnMarker.slice("KAKAPO_MENU_DRAWN=".length));
  assert.equal(drawnBack.length, drawn.length, "Electron accepted every accelerator the table can spell");
  for (const item of drawnBack) {
    assert.equal(item.registered, false, `${item.accelerator} must be drawn, not registered`);
  }

  const clashes = [];
  for (const row of SHORTCUTS) {
    if (row.fixed === "menu") continue;                      // the row already says the menu owns it
    for (const key of row.keys) if (eaten.has(key)) clashes.push(`${row.id} on ${key} — ${eaten.get(key)}`);
  }
  assert.deepEqual(clashes, [], `these rows can never fire:\n  ${clashes.join("\n  ")}`);
});

// The speller is in the shortcut table (electronAcceleratorFor) because a chord is written down there and
// this is a reading of it. What it must never do is hand Electron something Electron will not reject:
// buildFromTemplate accepted "Shift+⇧" for the ⇧⇧ row and "↵" for the find box's Enter, and both would have
// been DRAWN in the menu exactly like that. A row it cannot spell gets no accelerator at all.
test("the menu speller produces ASCII accelerators or none", async () => {
  for (const row of SHORTCUTS) {
    row.keys.forEach((key, index) => {
      const accelerator = electronAcceleratorFor(row.id, index);
      if (accelerator === undefined) return;
      assert.match(accelerator, /^[\x20-\x7e+]+$/,
        `${row.id} (${key}) spells as ${JSON.stringify(accelerator)}, which the menu would draw as-is`);
    });
  }
  // The rows with no Electron spelling, named so that adding one is a deliberate act: four key clusters,
  // the two Enters of the find box, and the double-Shift of Search Everywhere.
  const unspellable = SHORTCUTS
    .flatMap((row) => row.keys.map((key, index) => (electronAcceleratorFor(row.id, index) ? null : `${row.id}:${key}`)))
    .filter(Boolean)
    .sort();
  assert.deepEqual(unspellable, [
    "extendSelection:⇧←↑↓→", "findEnter:↵", "findEnter:⇧↵", "historyNavigate:↑↓",
    "moveCaret:←↑↓→", "searchEverywhere:⇧⇧", "sidebarNavigate:↑↓",
  ]);
});
