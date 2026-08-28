// A split layout is DOM structure, and only the tmux sessions survive a restart — so 1+(½,½) came back
// as three side-by-side columns (restorePanes gave every ordinal its own cell). The cell grouping is now
// written down as ordinals and rebuilt on restore. xterm doesn't boot under jsdom, so this pins the chain
// in the source the way the other terminal suites do.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const client = read("src/viewer/19-terminal.js");
const preload = read("src/preload.cts");
const terminalIpc = read("src/app-terminal-ipc.ts");

test("main answers a spawn with the tmux ordinal it took — the id is new every run, the ordinal is not", () => {
  const spawn = terminalIpc.match(/ipc\.handle\("kakapo:pty-spawn"[\s\S]*?\n  \}\);/)?.[0];
  assert.ok(spawn, "the spawn handler exists");
  assert.match(spawn, /return \{ ok: true, id, ordinal: session \? ordinal : undefined \}/,
    "…and only a tmux-backed pane gets one: a plain shell does not survive the restart this keys");
  assert.match(preload, /Promise<\{ ok: boolean; id: number; ordinal\?: number \}>/,
    "the bridge type carries it through");
});

test("the cell grouping is saved as ordinals whenever the structure changes", () => {
  const save = client.match(/function saveLayout\(\)[\s\S]*?\n  \}/)?.[0];
  assert.ok(save, "saveLayout exists");
  assert.match(save, /querySelectorAll\('\.terminal-cell'\)/, "it reads the real cell structure");
  assert.match(save, /panes\[k\]\.ordinal\) group\.push\(panes\[k\]\.ordinal\)/,
    "…as tmux ordinals, skipping panes that would not survive a restart anyway");
  assert.match(client, /pane\.ordinal = \(r && r\.ordinal\) \|\| pane\.ordinal;\s*\n\s*saveLayout\(\);/,
    "a spawn resolving records its ordinal and writes the layout — open, split and restore alike");
  const remove = client.match(/function removePaneRef\(p\)[\s\S]*?\n  \}/)?.[0];
  assert.match(remove, /saveLayout\(\);/, "closing a pane rewrites the layout too");
});

test("restorePanes rebuilds the saved cells instead of one column per session", () => {
  const restore = client.match(/function restorePanes\(\)[\s\S]*?\n  \}\n/)?.[0];
  assert.ok(restore, "restorePanes exists");
  assert.match(restore, /localStorage\.getItem\(layoutKey\)/, "the saved grouping is consulted");
  assert.match(restore, /if \(alive\.indexOf\(o\) >= 0 && !placed\[o\]\)/,
    "ordinals whose session died are dropped rather than restored as dead panes");
  assert.match(restore, /alive\.forEach\(function \(o\) \{ if \(!placed\[o\]\) groups\.push\(\[o\]\); \}\)/,
    "sessions the layout never met still get a cell — nothing that survived is lost");
  assert.match(restore, /var pane = makePane\(cell, ordinal\);\s*\n\s*if \(pane\) cell = pane\.el\.parentNode;/,
    "the first pane of a group opens the cell and the rest stack into that same cell");
});
