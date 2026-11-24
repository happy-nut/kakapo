import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeReviewHtml, cleanupFixtures } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const viewerDir = join(repoRoot, "src", "viewer");
const slices = readdirSync(viewerDir).filter((name) => name.endsWith(".js"));

test("only the holder talks to main about menu accelerators", () => {
  const callers = slices.filter((name) => /kakapoApp[^\n]*setIgnoreMenuShortcuts/.test(readFileSync(join(viewerDir, name), "utf8")));
  assert.deepEqual(callers, ["01-core.js"],
    "a panel that reaches past the registry can hold the window's Edit keys with nothing to release them");
});

test("every claim is a declaration, not a hold", () => {
  const offenders = [];
  for (const name of slices) {
    const text = readFileSync(join(viewerDir, name), "utf8");
    if (/\bholdMenuShortcuts\s*\(/.test(text)) offenders.push(name);
  }
  assert.deepEqual(offenders, [], "holdMenuShortcuts is gone — claimsMenuChords(name, isUp) is the only way in");
});

let html;
before(async () => {
  ({ html } = await makeReviewHtml([
    { path: "src/app.ts", before: "export const a = 1;\n", after: "export const a = 2;\n" },
  ]));
});
after(cleanupFixtures);

async function viewerWithSpy() {
  const v = await loadViewer(html);
  const asked = [];
  v.window.kakapoApp = Object.assign({}, v.window.kakapoApp, {
    setIgnoreMenuShortcuts: (ignore) => asked.push(ignore),
  });
  return { v, asked };
}

test("a claim that is up takes the chords, and dropping it hands them back", async () => {
  const { v, asked } = await viewerWithSpy();
  v.window.addComment("?", "src/app.ts", 1, "export const a = 2;", "why", 1, 1, "new");
  v.window.saveComments();
  await v.openMergedView();
  await v.settle(60);
  assert.deepEqual(asked, [true], "the dock is up, so the chords are taken once");

  v.window.__kakapoCloseDocks();
  await v.settle(60);
  assert.deepEqual(asked, [true, false], "and handed back when it goes");
  assert.equal(v.window.menuChordsHeld, false);
  v.close();
});

test("a caret in a field hands them back while the claim is still up", async () => {
  const { v, asked } = await viewerWithSpy();
  v.window.addComment("?", "src/app.ts", 1, "export const a = 2;", "why", 1, 1, "new");
  v.window.saveComments();
  await v.openMergedView();
  await v.settle(60);

  const field = v.window.document.getElementById("file-find-input");
  field.focus();
  v.window.document.dispatchEvent(new v.window.Event("focusin", { bubbles: true }));
  await v.settle(20);
  assert.deepEqual(asked, [true, false], "⌘V belongs to the field the caret is in");
  assert.ok(v.window.document.getElementById("mc-merged-panel"), "and the claim is still up");

  field.blur();
  v.window.document.dispatchEvent(new v.window.Event("focusin", { bubbles: true }));
  await v.settle(20);
  assert.deepEqual(asked, [true, false, true], "leaving the field gives them back to the claim");
  v.close();
});

test("recording a shortcut is the one claim that keeps them while typing, and says so", async () => {
  const core = readFileSync(join(viewerDir, "01-core.js"), "utf8");
  assert.match(core, /takesFieldEditingKeys/, "the exception exists in the holder");
  const takesFieldEditingKeys = slices.filter((name) => readFileSync(join(viewerDir, name), "utf8")
    .split("\n")
    .some((line) => line.includes("claimsMenuChords(") && line.includes("takesFieldEditingKeys")));
  assert.deepEqual(takesFieldEditingKeys, ["29-shortcut-rebind.js"],
    "only the recorder may swallow a field's own editing keys, because the field is the recorder");
});

test("a claim nobody registered holds nothing", async () => {
  const { v, asked } = await viewerWithSpy();
  await v.settle(20);
  assert.deepEqual(asked, [], "a quiet window never asks main for anything");
  assert.equal(v.window.menuChordsHeld, false);
  v.close();
});
