import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { appHasChord, chordsInApp, chordsClaimedIn } from "../scripts/lib/chords.mjs";

const READMES = ["README.md", "README_KR.md"];
const KNOWN_PRESENT = ["⌘O", "⌥]", "⌘⌥[", "⇧←↑↓→", "⌘⇧←→", "F7", "Esc"];

test("the reader finds the chords it is told are there, before any absence it reports is believed", () => {
  const app = chordsInApp();
  const unseen = KNOWN_PRESENT.filter((chord) => !appHasChord(app, chord));
  assert.deepEqual(unseen, [], "src/shortcuts.ts spells each of these, so a reader that misses one reports phantoms:\n  " + unseen.join("\n  "));

  for (const file of READMES) {
    const text = readFileSync(file, "utf8");
    const claimed = chordsClaimedIn(text).map((row) => row.chord);
    const written = KNOWN_PRESENT.filter((chord) => text.includes("| `" + chord + "`") || text.includes("`" + chord + "` /") || text.includes("` · `" + chord + "`"));
    const skipped = written.filter((chord) => !claimed.includes(chord));
    assert.deepEqual(skipped, [], `${file} writes each of these in a shortcut row, so a reader that skips one is blind there:\n  ` + skipped.join("\n  "));
  }
});

test("every chord the shortcut tables claim is one the app has", () => {
  const app = chordsInApp();
  const strays = READMES.flatMap((file) => chordsClaimedIn(readFileSync(file, "utf8"))
    .filter((row) => !appHasChord(app, row.chord))
    .map((row) => `${file}:${row.line}  ${row.chord}`));
  assert.deepEqual(strays, [], "a shortcut table claims a chord src/shortcuts.ts does not spell:\n  " + strays.join("\n  "));
});
