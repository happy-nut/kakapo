// ⌘⇧A lists the commands the PAGE can run, and the join is the shortcut table: an entry that did nothing
// when you pressed Enter on it would be worse than one that is absent (19-find-action.js says so). Two
// ways to be runnable, though — a `SHORTCUT_ACTIONS` entry, or a `FIND_ACTION_EXTRAS` one for a row whose
// chord a surface owner consumes before the dispatcher ever sees it. ⌘F is the whole reason the second
// list exists: it is the app's most-used search and it was missing from the palette.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeReviewHtml, cleanupFixtures } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";
import { SHORTCUTS } from "../dist/shortcuts.js";

let html;
before(async () => {
  ({ html } = await makeReviewHtml([
    { path: "src/app.ts", before: "export const x = 1;\n", after: "export const x = 2;\n" },
  ]));
});
after(cleanupFixtures);

test("every extra is a real table row that genuinely has no dispatcher", async () => {
  const v = await loadViewer(html);
  const extras = Object.keys(v.window.FIND_ACTION_EXTRAS);
  assert.ok(extras.length > 0, "the list is in use — otherwise this guard is furniture");
  for (const id of extras) {
    assert.ok(SHORTCUTS.some((row) => row.id === id), `${id} is a row in the table`);
    // If it ever gains a dispatcher, it belongs in that list and not in this one — two registries for
    // one id is exactly what the table exists to prevent.
    assert.equal(typeof v.window.SHORTCUT_ACTIONS[id], "undefined",
      `${id} has a dispatcher now; drop it from FIND_ACTION_EXTRAS`);
    assert.equal(typeof v.window.FIND_ACTION_EXTRAS[id], "function", `${id} is callable`);
  }
  v.close();
});

test("the palette offers Find in current file, and running it opens the bar", async () => {
  const v = await loadViewer(html);
  v.window.openFindAction();
  await v.settle(40);

  const listed = v.window.findActionItems().map((item) => item.actionId);
  assert.ok(listed.includes("findInFile"), "⌘F is in the command palette");
  assert.ok(listed.includes("findInFiles"), "...alongside the one that always was");

  // And it does something: the bar is up afterwards, which is the promise a palette row makes.
  assert.equal(v.window.isFileFindOpen(), false, "the bar starts closed");
  const row = v.window.findActionItems().find((item) => item.actionId === "findInFile");
  assert.equal(v.window.runFindActionItem({ kind: "action", actionId: row.actionId }), true, "the row runs");
  await v.settle(40);
  assert.equal(v.window.isFileFindOpen(), true, "and the find bar is open");
  v.close();
});

test("a row with neither a dispatcher nor an extra is still absent", async () => {
  const v = await loadViewer(html);
  const listed = new Set(v.window.findActionItems().map((item) => item.actionId));
  // The find bar's own toggles act on a surface that must already be open; a palette row for one would
  // be the entry that does nothing. They are left out on purpose, and this says so out loud.
  for (const id of ["searchMatchCase", "searchWholeWords", "searchRegex"]) {
    assert.ok(SHORTCUTS.some((row) => row.id === id), `${id} is a table row`);
    assert.ok(!listed.has(id), `${id} is not offered — it needs its surface open`);
  }
  v.close();
});
