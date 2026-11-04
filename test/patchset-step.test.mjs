// Stepping the patch-set bar from the keyboard (⌥] / ⌥[).
//
// The bar offers a branch's commits as comparison points — "patch sets", which is what every other layer
// has called them all along (the module, the IPC, the tooltips) while the bar itself showed only
// "Base 1 2 3 Target". Naming it on screen is half of this; a key that walks it is the other half, because
// reaching the fourth of thirty-three with the pointer is thirty-three small targets.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeReviewHtml, cleanupFixtures } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";

let html;
before(async () => {
  // app: true — the patch-set bar is an Electron-only affordance, so the default standalone review has
  // no bar at all and every assertion below would be about markup that was never rendered.
  ({ html } = await makeReviewHtml([
    { path: "src/app.ts", before: "export const n = 1;\n", after: "export const n = 2;\n" },
  ], { app: true }));
});
after(cleanupFixtures);

const COMMITS = [
  { sha: "aaa1111", subject: "first", shortSha: "aaa1111", date: "" },
  { sha: "bbb2222", subject: "second", shortSha: "bbb2222", date: "" },
  { sha: "ccc3333", subject: "third", shortSha: "ccc3333", date: "" },
];

// Drive the real bar: set its data, render it, and record what the picker is asked for.
async function barWith(activeBase) {
  const v = await loadViewer(html);
  const picked = [];
  v.window.kakapoGit = Object.assign({}, v.window.kakapoGit, {
    setReviewCompare: (base, target) => { picked.push(["compare", base, target]); return Promise.resolve({ ok: true, activeBase: base, activeTarget: target }); },
    setReviewTarget: (ref) => { picked.push(["target", ref]); return Promise.resolve({ ok: true, activeTarget: ref }); },
    setReviewBase: (ref) => { picked.push(["base", ref]); return Promise.resolve({ ok: true, activeBase: ref }); },
  });
  v.window.eval(`patchSetData = ${JSON.stringify({
    branchPoint: { sha: "54d784f", label: "main" },
    commits: COMMITS, scoped: true, activeBase, activeTarget: "worktree",
  })}, 1`);
  v.window.renderPatchSetBar();
  await v.settle(20);
  return { v, picked };
}
const press = (v, shifted) => v.document.dispatchEvent(new v.window.KeyboardEvent("keydown", {
  key: shifted ? "{" : "}", code: shifted ? "BracketLeft" : "BracketRight", altKey: true, bubbles: true, cancelable: true,
}));
const hint = (v) => {
  const el = v.$(".mc-caret-hint");
  return el && el.classList.contains("show") ? el.textContent.trim() : "";
};

test("the bar says what it is", async () => {
  const { v } = await barWith("aaa1111");
  const name = v.$("#patchset-bar .patchset-name");
  assert.ok(name, "the bar carries its own name");
  assert.equal(name.getAttribute("data-i18n"), "patchset.name",
    "from the table, so a locale switch repaints it");
  assert.equal(name.textContent, v.window.t("patchset.name"));
  v.close();
});

test("⌥] moves to the next patch set and ⌥[ back", async () => {
  const { v, picked } = await barWith("aaa1111");
  press(v, false);
  await v.settle(20);
  assert.deepEqual(picked.at(-1), ["compare", "bbb2222", "worktree"], "forward to the second");

  v.window.eval(`patchSetData.activeBase = "bbb2222", 1`);
  v.window.renderPatchSetBar();
  press(v, true);
  await v.settle(20);
  assert.deepEqual(picked.at(-1), ["compare", "aaa1111", "worktree"], "and back to the first");
  v.close();
});

test("it walks the whole list, including the option the numbers do not number", async () => {
  // "All" is a patch-set option like any other — the branch point, offered first on an ordinary branch bar
  // — so stepping back off the first commit lands on it rather than stopping. A walk that only knew about
  // digits would skip the one option a reader most often wants to get back to.
  //
  // `scoped: false` is what makes that option exist (patchSetBaseOptions offers the branch point only
  // outside a ⌘9 range), and picking it goes the way ⌥A goes rather than down the patch-set path, because
  // "All changes" is the same question ⌥A asks.
  const v = await loadViewer(html);
  const modes = [];
  v.window.kakapoGit = Object.assign({}, v.window.kakapoGit, {
    setCompareMode: (mode, ref) => { modes.push([mode, ref || null]); return Promise.resolve({ ok: true, mode, ref }); },
    setReviewBase: () => Promise.resolve({ ok: true }),
  });
  v.window.eval(`patchSetData = ${JSON.stringify({
    branchPoint: { sha: "54d784f", label: "main" },
    commits: COMMITS, scoped: false, activeBase: "aaa1111", activeTarget: "worktree",
  })}, 1`);
  v.window.renderPatchSetBar();
  await v.settle(20);

  press(v, true);
  await v.settle(30);
  assert.deepEqual(modes.at(-1), ["all", null], "back off the first commit is 'All', asked the way ⌥A asks it");
  v.close();
});

test("the ends say so instead of doing nothing", async () => {
  // The same bargain F7 makes at a file boundary: a key that moves must either move or say why it did not.
  const { v, picked } = await barWith("ccc3333"); // the newest
  const before = picked.length;
  press(v, false);
  await v.settle(20);
  assert.equal(picked.length, before, "nothing was picked past the end");
  assert.match(hint(v), /latest|최근/i, "and the key said so");
  v.close();
});

test("with no bar there is nothing to step, and the key declines", async () => {
  // `where: "any"` means this chord is offered everywhere; a review with no patch-set bar (no commits of
  // its own) must let it fall through rather than swallow it.
  const v = await loadViewer(html);
  v.window.eval(`patchSetData = null, 1`);
  v.window.renderPatchSetBar();
  await v.settle(20);
  assert.equal(v.window.stepPatchSet(1), false, "declined, so the chord is free for whatever else wants it");
  v.close();
});
