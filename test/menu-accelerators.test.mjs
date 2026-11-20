import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { SHORTCUTS, MENU_OWNED_CHORDS, MENU_OWNED_CHORDS_MAC, electronAcceleratorFor } from "../dist/shortcuts.js";

const require = createRequire(import.meta.url);

const FORWARDING_ROLES = new Set(["editmenu", "undo", "redo", "cut", "copy", "paste",
  "pasteandmatchstyle", "delete", "selectall"]);

const SHIFTED = { Plus: ["+", "="], Underscore: ["_", "-"], Colon: [":", ";"], Tilde: ["~", "`"] };
const NAMED = { Plus: "+", Space: "Space", Backspace: "Backspace", Delete: "Delete", Tab: "Tab",
  Return: "Enter", Enter: "Enter", Escape: "Esc", Up: "↑", Down: "↓", Left: "←", Right: "→",
  PageUp: "PageUp", PageDown: "PageDown" };

function spell(mods, key) {
  const command = ["CommandOrControl", "CmdOrCtrl", "Command", "Cmd", "Control", "Ctrl", "Super", "Meta"]
    .some((name) => mods.has(name));
  return (command ? "⌘" : "") + (mods.has("Shift") ? "⇧" : "")
    + (mods.has("Alt") || mods.has("Option") ? "⌥" : "")
    + (NAMED[key] ?? (key.length === 1 ? key.toUpperCase() : key));
}

function spellExact(mods, key) {
  const meta = ["CommandOrControl", "CmdOrCtrl", "Command", "Cmd", "Super", "Meta"].some((n) => mods.has(n));
  const ctrl = ["Control", "Ctrl"].some((n) => mods.has(n));
  return (meta ? "⌘" : "") + (mods.has("Shift") ? "⇧" : "")
    + (mods.has("Alt") || mods.has("Option") ? "⌥" : "") + (ctrl ? "⌃" : "")
    + (NAMED[key] ?? (key.length === 1 ? key.toUpperCase() : key));
}
function foldExact(accelerator) {
  const parts = accelerator.split("+");
  const key = parts.pop();
  const mods = new Set(parts);
  const shifted = SHIFTED[key];
  if (!shifted) return [spellExact(mods, key)];
  const withShift = new Set(mods);
  withShift.add("Shift");
  return [spellExact(mods, shifted[0]), spellExact(withShift, shifted[1])];
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

test("no shortcut row sits on a chord the application menu eats", {
  timeout: 60_000,
  skip: process.platform !== "darwin" ? "the application menu this guards is macOS's" : false,
}, async () => {
  const main = readFileSync(fileURLToPath(new URL("../dist/app-main.js", import.meta.url)), "utf8");

  const roles = [...new Set([...main.matchAll(/role:\s*"([A-Za-z]+)"/g)].map((m) => m[1]))];
  assert.ok(roles.includes("appMenu"), `the macOS app menu is still built from a role: ${roles.join(", ")}`);

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

  const eaten = new Map();
  const forwarded = new Set();
  for (const item of fromRoles) {
    if (item.role && FORWARDING_ROLES.has(item.role.toLowerCase())) {
      for (const chord of foldAll(item.accelerator)) forwarded.add(chord);
      continue;
    }
    for (const chord of foldAll(item.accelerator)) eaten.set(chord, `the ${item.role || item.label} menu item (${item.accelerator})`);
  }
  assert.ok(eaten.has("⌘⌥H"), "role: appMenu still binds Hide Others to ⌘⌥H");

  const claimed = new Map(eaten);
  for (const m of main.matchAll(/accelerator:\s*"([^"]+)"/g)) {
    const around = main.slice(Math.max(0, m.index - 320), m.index + 320);
    const forwards = around.includes("sendToFocused");
    for (const chord of foldExact(m[1])) claimed.set(chord, `a menu item that registers it (${m[1]})`);
    if (!forwards) {
      for (const chord of foldAll(m[1])) eaten.set(chord, `a menu item that does not forward it (${m[1]})`);
    }
  }
  for (const chord of [...claimed.keys()]) if (chord.includes("⌃")) claimed.delete(chord);

  assert.deepEqual(
    [...MENU_OWNED_CHORDS, ...MENU_OWNED_CHORDS_MAC].sort(),
    [...claimed.keys()].sort(),
    "MENU_OWNED_CHORDS (+ _MAC) in src/shortcuts.ts is every chord the menu registers",
  );
  for (const chord of MENU_OWNED_CHORDS_MAC) {
    assert.ok(eaten.has(chord), `${chord} is held by a macOS menu role`);
    assert.ok(!MENU_OWNED_CHORDS.includes(chord), `${chord} is listed once, not in both lists`);
  }

  assert.ok(eaten.has("⌘+") && eaten.has("⌘⇧="),
    "CommandOrControl+Plus is one keystroke with two spellings and both must be claimed");

  const unheld = SHORTCUTS
    .filter((row) => row.fixed === "menu")
    .flatMap((row) => row.keys
      .filter((key) => !claimed.has(key) && !forwarded.has(key))
      .map((key) => `${row.id} on ${key}`));
  assert.deepEqual(unheld, [],
    `every fixed: "menu" row spells a chord a menu item holds:\n  ${unheld.join("\n  ")}`);

  const drawnMarker = result.stdout.split(/\r?\n/).find((line) => line.startsWith("KAKAPO_MENU_DRAWN="));
  assert.ok(drawnMarker, `drawn accelerators missing\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  const drawnBack = JSON.parse(drawnMarker.slice("KAKAPO_MENU_DRAWN=".length));
  assert.equal(drawnBack.length, drawn.length, "Electron accepted every accelerator the table can spell");
  for (const item of drawnBack) {
    assert.equal(item.registered, false, `${item.accelerator} must be drawn, not registered`);
  }

  const clashes = [];
  for (const row of SHORTCUTS) {
    if (row.fixed === "menu") continue;
    for (const key of row.keys) if (eaten.has(key)) clashes.push(`${row.id} on ${key} — ${eaten.get(key)}`);
  }
  assert.deepEqual(clashes, [], `these rows can never fire:\n  ${clashes.join("\n  ")}`);
});

test("the menu speller produces ASCII accelerators or none", async () => {
  for (const row of SHORTCUTS) {
    row.keys.forEach((key, index) => {
      const accelerator = electronAcceleratorFor(row.id, index);
      if (accelerator === undefined) return;
      assert.match(accelerator, /^[\x20-\x7e+]+$/,
        `${row.id} (${key}) spells as ${JSON.stringify(accelerator)}, which the menu would draw as-is`);
    });
  }
  const unspellable = SHORTCUTS
    .flatMap((row) => row.keys.map((key, index) => (electronAcceleratorFor(row.id, index) ? null : `${row.id}:${key}`)))
    .filter(Boolean)
    .sort();
  assert.deepEqual(unspellable, [
    "extendSelection:⇧←↑↓→", "findEnter:↵", "findEnter:⇧↵", "historyNavigate:↑↓",
    "moveCaret:←↑↓→", "searchEverywhere:⇧⇧", "sidebarNavigate:↑↓",
  ]);
});
