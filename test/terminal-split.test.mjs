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
