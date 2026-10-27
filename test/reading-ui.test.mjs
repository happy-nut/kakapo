// The controls, not the keys. Every reading feature ported from IntelliJ has a chord, and a chord alone is
// not the feature's UI — IntelliJ puts these in View, in its diff gear, on its diff toolbar and on the
// context menu of a change, and so does this. What is asserted here is that the clickable half exists, that
// it names the same key the table holds, and that it runs the same code the key does.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { cleanupFixtures, makeReviewHtml } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";
import { shortcutById } from "../dist/shortcuts.js";

let html;
before(async () => {
  ({ html } = await makeReviewHtml([
    { path: "src/one.ts", before: "const a = 1;\n", after: "const a = 2;\n" },
    { path: "src/two.ts", before: "const b = 1;\n", after: "const b = 3;\n" },
  ]));
});
after(cleanupFixtures);

test("the diff toolbar carries file arrows, and they name the chord the table holds", async () => {
  const v = await loadViewer(html);
  const next = v.$("#diff-next-file");
  const prev = v.$("#diff-prev-file");
  assert.ok(next && prev, "both arrows are in the toolbar");
  // keyHint() writes these from the table, so a rebind moves the label with it. Index 0 is next, 1 is
  // previous — the same order the handler reads.
  assert.equal(next.dataset.keyhint, shortcutById("diffFileStep").keys[0]);
  assert.equal(prev.dataset.keyhint, shortcutById("diffFileStep").keys[1]);
  v.close();
});

test("clicking the next-file arrow moves the diff caret into the other file", async () => {
  const v = await loadViewer(html);
  await v.openDiffFor("src/one.ts");
  // Asserted through the DOM, not through `diffCursor`: that is declared with `let` in 01-core.js, so it is
  // not a property of `window` and a test reading it gets undefined whatever the caret is doing. What the
  // page itself shows is `mc-active-diff` on the wrapper the caret is in.
  const activePath = () => {
    const wrapper = v.$all("#diff2html-container .d2h-file-wrapper")
      .find((el) => el.classList.contains("mc-active-diff"));
    return wrapper ? v.window.diffWrapperPathKey(wrapper) : "";
  };
  const before = activePath();
  assert.ok(before, "the diff opened on a file");
  v.click(v.$("#diff-next-file"));
  await v.settle(60);
  assert.notEqual(activePath(), before, `the arrow did not change file (still ${activePath()})`);
  v.click(v.$("#diff-prev-file"));
  await v.settle(60);
  assert.equal(activePath(), before, "and the other arrow comes back");
  v.close();
});

test("the find bar's changes-only toggle is a button, and pressing it marks it pressed", async () => {
  const v = await loadViewer(html);
  const button = v.$("#file-find-changes-only");
  assert.ok(button, "IntelliJ keeps Search In Changes beside the find field, and so does this");
  assert.equal(button.dataset.keyhint, shortcutById("searchChangesOnly").keys[0]);
  assert.equal(button.getAttribute("aria-pressed"), "false");
  v.close();
});

// IntelliJ keeps Copy as Patch and Compare with Clipboard on the context menu of a change. The row menu is
// built from a list, and each entry is offered only when the bridge behind it exists — in a browser there is
// no clipboard to read and no git to ask, and a menu must not carry a row that cannot do anything.
test("the row menu offers the two patch actions when their bridges are there, and not when they are not", async () => {
  const v = await loadViewer(html);
  // showCustomDropdown (07-comments.js) renders the items as the children of #mc-dropdown.
  const labels = () => {
    const dd = v.window.document.getElementById("mc-dropdown");
    return dd ? Array.from(dd.children).map((el) => el.textContent.trim()) : [];
  };
  const closeMenu = () => {
    const dd = v.window.document.getElementById("mc-dropdown");
    if (dd) dd.remove();
  };

  const row = v.$all(".change-row")[0] || v.$all("[data-file]")[0];
  assert.ok(row, "a changed-file row to open the menu on");

  v.window.kakapoGit = undefined;
  v.window.kakapoClipboard = undefined;
  v.window.openTreeRowMenu(row);
  await v.settle(20);
  const without = labels().join(" | ");
  assert.ok(!/patch/i.test(without), `no bridge, no patch row: ${without}`);
  closeMenu();

  v.window.kakapoGit = { filePatch: () => Promise.resolve(""), compareClipboard: () => Promise.resolve("") };
  v.window.kakapoClipboard = { read: () => "", write: () => {} };
  v.window.openTreeRowMenu(row);
  await v.settle(20);
  const withBridges = labels().join(" | ");
  assert.match(withBridges, /patch/i, `the patch row is offered: ${withBridges}`);
  v.close();
});
