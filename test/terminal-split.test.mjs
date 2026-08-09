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

test("the client turns the direction into the layout class and re-fits xterm afterwards", () => {
  const split = client.match(/function split\(direction\)[\s\S]*?\n  \}/)?.[0];
  assert.ok(split, "split takes a direction");
  assert.match(split, /classList\.toggle\('is-column', direction === 'column'\)/,
    "column splits set the class AND row splits clear it, so the axis can be switched back");
  assert.match(split, /requestAnimationFrame\(fitAll\)/,
    "xterm is re-fitted after the new axis is laid out, not only against the pre-split geometry");
  assert.match(client, /onTerminalSplit\(split\)/, "the bridge is wired to it");
});

test("a stacked split has a layout that can actually show two panes", () => {
  assert.match(css, /\.terminal-host\.is-column \{[^}]*flex-direction: column/,
    "the class the client sets is the one that flips the axis");
  const pane = css.match(/^\.terminal-pane \{[^}]*\}/m)?.[0];
  assert.ok(pane, ".terminal-pane rule exists");
  assert.match(pane, /min-height: 0/,
    "without min-height a flex-column child cannot shrink and the stacked panes collapse to nothing");
  assert.match(pane, /flex: 1 1 0/, "panes still share the axis evenly");
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
