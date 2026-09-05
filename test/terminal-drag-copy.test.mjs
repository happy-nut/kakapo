// tmux keeps mouse tracking on for every pane, so a plain drag never forms an xterm selection — the events
// go to tmux, and in an agent pane on to a TUI with no selection of its own. On macOS xterm's designed
// bypass is Option+drag, but only behind macOptionClickForcesSelection (default false); without it there is
// NO gesture that selects locally, and the Cmd+C handler reads an empty selection forever. xterm does not
// boot under jsdom, so this pins the wiring instead: the flag is set where the terminal is built, and the
// copy path it feeds still exists.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const client = readFileSync(new URL("../src/viewer/19-terminal.js", import.meta.url), "utf8");

test("Option+drag can force a local selection despite tmux's mouse tracking", () => {
  const ctor = client.match(/new window\.Terminal\(\{[\s\S]*?\}\);/)?.[0];
  assert.ok(ctor, "the terminal is still built in one place");
  assert.match(ctor, /macOptionClickForcesSelection: true/,
    "the macOS bypass is on — xterm's default (false) leaves no gesture that selects locally under mouse tracking");
});

test("what Option+drag selects, Cmd+C copies", () => {
  assert.match(client, /e\.code === 'KeyC' && term\.hasSelection && term\.hasSelection\(\)/,
    "the copy shortcut checks the local selection");
  assert.match(client, /copyToClipboard\(term\.getSelection\(\)\)/,
    "…and hands exactly that selection to the clipboard");
});
