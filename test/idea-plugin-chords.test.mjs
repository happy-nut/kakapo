import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const plugin = readFileSync(join(repoRoot, "intellij-plugin/src/main/resources/META-INF/plugin.xml"), "utf8");
const keymap = JSON.parse(readFileSync(join(repoRoot, "test/fixtures/intellij-mac-keymap.json"), "utf8"));

// IntelliJ writes "meta shift SLASH" and a plugin.xml may write "shift meta SLASH". They are the same
// chord, and comparing the strings says they are not — which is how the collision this test exists for
// survived its first draft.
function canonical(chord) {
  const parts = chord.trim().split(/\s+/);
  const key = parts.pop();
  return [...parts].sort().join(" ") + (parts.length ? " " : "") + key;
}

function declaredChords() {
  const rows = [];
  for (const action of plugin.matchAll(/<action id="([^"]+)"([\s\S]*?)<\/action>/g)) {
    for (const stroke of action[2].matchAll(/first-keystroke="([^"]+)"/g)) {
      rows.push({ id: action[1], chord: canonical(stroke[1]), written: stroke[1] });
    }
  }
  return rows;
}

test("the fixture can see a binding, so an empty answer means free and not blind", () => {
  assert.deepEqual(keymap.spent[canonical("shift meta SLASH")], ["CommentByBlockComment"],
    "⌘⇧/ is block comment on macOS; if this fixture says otherwise it was captured wrong");
  assert.ok(Object.keys(keymap.spent).length > 300, `and it holds a whole keymap: ${Object.keys(keymap.spent).length}`);
});

test("no chord the plugin declares is one IntelliJ already spends", () => {
  const rows = declaredChords();
  assert.ok(rows.length >= 2, `the plugin declares its chords here: ${rows.length}`);
  const clashes = rows
    .filter((row) => keymap.spent[row.chord])
    .map((row) => `${row.id} wants ${row.written}, which IntelliJ gives to ${keymap.spent[row.chord].join(", ")}`);
  assert.deepEqual(clashes, [],
    "refresh the fixture with `npm run idea:keymap` if the IDE moved, otherwise pick a free chord");
});

test("the README table is the chords the plugin declares, written for a reader", () => {
  const readme = readFileSync(join(repoRoot, "intellij-plugin/README.md"), "utf8");
  const spelled = { "alt meta shift SLASH": "⌥⇧⌘/", "control meta shift SLASH": "⌃⇧⌘/" };
  for (const { id, chord } of declaredChords()) {
    const shown = spelled[chord];
    assert.ok(shown, `${chord} (${id}) has no spelling here; add one when you add a chord`);
    assert.ok(readme.includes(shown), `the README table is missing ${shown} for ${id}`);
  }
});
