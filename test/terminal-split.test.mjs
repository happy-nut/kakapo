// Cmd+D splits the terminal side by side; Cmd+Shift+D stacks the panes top/bottom. The panes are xterm
// instances, which don't boot under jsdom, so this pins the chain that made the shortcut a no-op instead:
// the accelerator has to exist, the direction has to survive main -> preload -> client, and the column
// layout has to actually be expressible in CSS (a flex column whose children have no min-height collapses
// every pane to zero, which looks exactly like "the split did nothing").
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const appMain = read("src/app-main.ts");
const preload = read("src/preload.cts");
const client = read("src/viewer/19-terminal.js");
const css = read("src/viewer.css");

test("both split directions are bound to accelerators and carry a direction", () => {
  const right = appMain.match(/accelerator: "CommandOrControl\+D".*/)?.[0];
  const down = appMain.match(/accelerator: "CommandOrControl\+Shift\+D".*/)?.[0];
  assert.ok(right, "Cmd+D is still bound");
  assert.ok(down, "Cmd+Shift+D is bound at all — it previously matched nothing, so the key did nothing");
  assert.match(right, /kakapo:terminal-split", "row"/, "Cmd+D asks for a side-by-side split");
  assert.match(down, /kakapo:terminal-split", "column"/, "Cmd+Shift+D asks for a stacked split");
});

test("the preload forwards the direction and defaults anything unexpected to a side-by-side split", () => {
  const handler = preload.match(/onTerminalSplit:[\s\S]*?\n  \},/)?.[0];
  assert.ok(handler, "onTerminalSplit bridge exists");
  assert.match(handler, /\(_event, direction\)/, "the direction is read off the IPC event, not dropped");
  assert.match(handler, /direction === "column" \? "column" : "row"/,
    "an unknown/missing direction falls back to the old behavior rather than silently stacking");
});

// A stacked split must act on the pane you are IN. The panel used to carry a single axis for every pane, so
// Cmd+Shift+D flipped the whole panel — two side-by-side panes suddenly became two stacked ones. Panes now
// live in cells (the panel is a row of cells, a cell is a column of panes), so a stacked split adds to the
// focused pane's own cell and leaves every other pane where it was.
test("a stacked split nests inside the focused pane's cell instead of re-orienting the panel", () => {
  const split = client.match(/function split\(direction\)[\s\S]*?\n  \}/)?.[0];
  assert.ok(split, "split takes a direction");
  assert.match(split, /direction === 'column' && active[\s\S]{0,80}active\.el\.parentNode : makeCell\(\)/,
    "column splits reuse the active pane's cell; row splits open a new one");
  assert.doesNotMatch(split, /is-column/, "no panel-wide axis flag survives");
  assert.match(split, /requestAnimationFrame\(fitAll\)/,
    "xterm is re-fitted after the new layout, not only against the pre-split geometry");
  assert.match(client, /onTerminalSplit\(split\)/, "the bridge is wired to it");
  // An emptied cell would keep its share of the row and read as a gap where the pane used to be.
  assert.match(client, /!cell\.children\.length[\s\S]{0,60}removeChild\(cell\)/,
    "closing the last pane of a cell removes the cell");
});

test("cells and panes can both actually shrink, so a stacked split shows two panes", () => {
  const cell = css.match(/^\.terminal-cell \{[^}]*\}/m)?.[0];
  assert.ok(cell, ".terminal-cell rule exists");
  assert.match(cell, /flex-direction: column/, "a cell stacks its panes");
  assert.match(cell, /min-height: 0/, "and can shrink inside the row");
  assert.match(cell, /flex: 1 1 0/, "cells share the row evenly");
  const pane = css.match(/^\.terminal-pane \{[^}]*\}/m)?.[0];
  assert.ok(pane, ".terminal-pane rule exists");
  assert.match(pane, /min-height: 0/,
    "without min-height a flex-column child cannot shrink and the stacked panes collapse to nothing");
  assert.match(pane, /flex: 1 1 0/, "panes still share their cell evenly");
});

// Cmd+0 / Cmd+1 reveal the Changes / Files tree, and the floating terminal covers exactly that — leaving it
// open made the shortcut look like it had done nothing. Both funnels (keyboard and the activity-rail icons)
// go through these two functions, so the close belongs there rather than in the key handler.
const keymap = read("src/viewer/05-keymap.js");

test("switching to Changes or Files puts an open terminal away", () => {
  for (const fn of ["activateChangesView", "activateFilesView"]) {
    const body = keymap.match(new RegExp(`function ${fn}\\([^)]*\\) \\{\\n([^\\n]*\\n){0,2}`))?.[0];
    assert.ok(body, `${fn} exists`);
    assert.match(body, /closeTerminalForViewSwitch\(\)/, `${fn} closes the terminal first`);
  }
});

test("the close never toggles a closed terminal back on", () => {
  const helper = keymap.match(/function closeTerminalForViewSwitch\(\)[\s\S]*?\n\}/)?.[0];
  assert.ok(helper, "helper exists");
  assert.match(helper, /if \(api\.isOpen\(\)\) api\.close\(\)/,
    "guarded on isOpen — close() is a plain close, but the guard keeps this honest if it ever becomes a toggle");
  assert.match(helper, /typeof api\.isOpen !== 'function'/, "no-ops when the terminal bundle never booted");
});

// Esc closes the terminal panel. At a shell prompt one press does it; in a fullscreen TUI (vim, less, and
// crucially Claude Code, where Esc is the interrupt) the first press has to reach the app, so a second press
// within the window closes instead. Getting this wrong takes away the interrupt key.
const terminal = read("src/viewer/19-terminal.js");

test("Esc closes at a shell prompt but never steals the TUI's first press", () => {
  const handler = terminal.match(/if \(e\.type === 'keydown' && e\.key === 'Escape'[\s\S]*?\n      \}/)?.[0];
  assert.ok(handler, "the Escape branch exists");
  assert.match(handler, /if \(normalBuffer\) \{[^}]*setOpen\(false\)/,
    "a normal shell prompt closes on the first press");
  assert.match(handler, /return true; \/\/ first press belongs to the TUI/,
    "in the alternate buffer the first Esc is passed through, not swallowed");
  assert.match(handler, /now - lastEscAt < ESC_CLOSE_MS[\s\S]{0,60}setOpen\(false\)/,
    "a second Esc inside the window closes the panel");
});

test("the double-Esc window is armed only by an Esc, and cleared when it fires", () => {
  assert.match(terminal, /var ESC_CLOSE_MS = \d+;\s*\n\s*var lastEscAt = 0;/, "state is declared once per panel");
  const handler = terminal.match(/if \(e\.type === 'keydown' && e\.key === 'Escape'[\s\S]*?\n      \}/)?.[0];
  // Without the reset, one Esc long ago plus one now would close instead of interrupting twice.
  assert.equal((handler.match(/lastEscAt = 0/g) || []).length, 2, "both close paths reset the window");
  assert.match(handler, /lastEscAt = now;/, "and a passed-through press arms it");
});

// The terminal's whole runtime is inlined as one island (assets.ts -> render.ts), so what that island
// exposes IS the terminal's feature set: xterm itself, the fit addon that keeps it sized to the pane, and
// the link addon 19-terminal.js hands clicked URLs from. A missing addon must not be able to take the
// terminal with it — the renderer already skips the link addon when its global is absent.
test("the xterm island carries the terminal runtime, and links stay optional", async () => {
  const { xtermScript } = await import("../dist/assets.js");
  const island = xtermScript();
  assert.ok(island.length > 100_000, "the island is the real xterm bundle, not an empty fallback");
  for (const global of ["Terminal", "FitAddon", "WebLinksAddon"]) {
    assert.ok(island.includes(global), `the island exposes window.${global}`);
  }
});

// Terminal output is untrusted: any command can print a string that becomes a clickable link. The click has
// to leave the renderer (which cannot reach the OS) and be re-checked in main before the browser opens.
test("a clicked link in the terminal leaves for the default browser through the checked main-process path", () => {
  assert.match(client, /new window\.WebLinksAddon\.WebLinksAddon\(/, "link detection is the xterm addon's job");
  assert.match(client, /kakapoApp\.openExternal\(uri\)/, "a click hands the URI to main, not to window.open");
  assert.match(client, /event\.button !== 0/, "only a primary click follows the link");

  const preload = read("src/preload.cts");
  assert.match(preload, /openExternal:.*invoke\("kakapo:open-external", \{ url \}\)/, "the bridge forwards only the url");

  const pathIpc = read("src/app-path-ipc.ts");
  assert.match(pathIpc, /ipc\.handle\("kakapo:open-external"/, "main owns the handler");
  assert.match(pathIpc, /const url = externalUrl\(request\?\.url\)/, "every URL goes through the scheme check");

  const xtermBundle = read("src/assets.ts");
  assert.match(xtermBundle, /addon-web-links\/lib\/addon-web-links\.js/, "the addon ships with the inlined xterm bundle");
});

