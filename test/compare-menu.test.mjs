// CORE USER FLOW: the compare dropdown on the toolbar pill. Two rows — everything on this branch, and what
// is not committed yet — plus the branch the first of them is measured against. ⌥C flips between the two
// without opening anything. These guard the wiring (what reaches the main process) rather than the styling.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeReviewHtml, cleanupFixtures } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";

let html;
before(async () => {
  ({ html } = await makeReviewHtml([
    { path: "src/a.ts", before: "export const a = 1;\n", after: "export const a = 2;\n" },
  ], { app: true }));
});
after(cleanupFixtures);

// `calls` is every setCompareMode(mode, ref) the menu asked for — the whole observable behaviour.
function installCompareBridge(v, state = {}) {
  const calls = [];
  const data = {
    mode: "uncommitted",
    ref: "origin/main",
    defaultRef: "origin/main",
    branches: ["main", "origin/main", "feature/dropdown", "origin/release-1"],
    ...state,
  };
  v.window.kakapoGit = {
    compareMenu: () => Promise.resolve(JSON.parse(JSON.stringify(data))),
    setCompareMode: (mode, ref) => {
      calls.push([mode, ref ?? null]);
      return Promise.resolve({ ok: true, mode, ref: ref || data.ref });
    },
  };
  return calls;
}

test("the pill opens a menu that marks the mode the review is actually in", async () => {
  const v = await loadViewer(html);
  installCompareBridge(v);

  v.$("#compare-pill").dispatchEvent(new v.window.MouseEvent("click", { bubbles: true }));
  await v.settle(30);

  assert.equal(v.$("#compare-menu").classList.contains("hidden"), false, "the menu opened");
  const rows = v.$all("#compare-menu .compare-menu-row[data-mode]");
  assert.deepEqual(rows.map((r) => r.dataset.mode), ["all", "uncommitted"]);
  assert.equal(rows[1].getAttribute("aria-checked"), "true", "the row the review is on is the checked one");
  assert.equal(rows[0].getAttribute("aria-checked"), "false");
  assert.match(v.$("#compare-menu-against").textContent, /origin\/main/, "the 'all' row names what it compares against");
  v.close();
});

test("picking a row switches the mode and closes the menu", async () => {
  const v = await loadViewer(html);
  const calls = installCompareBridge(v);

  v.$("#compare-pill").dispatchEvent(new v.window.MouseEvent("click", { bubbles: true }));
  await v.settle(30);
  v.$('#compare-menu .compare-menu-row[data-mode="all"]').dispatchEvent(new v.window.MouseEvent("click", { bubbles: true }));
  await v.settle(30);

  assert.deepEqual(calls, [["all", null]], "the mode change reached the main process");
  assert.equal(v.$("#compare-menu").classList.contains("hidden"), true, "and the menu got out of the way");
  v.close();
});

test("the branch panel filters as you type and a pick carries the branch", async () => {
  const v = await loadViewer(html);
  const calls = installCompareBridge(v);

  v.$("#compare-pill").dispatchEvent(new v.window.MouseEvent("click", { bubbles: true }));
  await v.settle(30);
  v.$(".compare-menu-branch-open").dispatchEvent(new v.window.MouseEvent("click", { bubbles: true }));
  await v.settle(20);

  const names = () => v.$all("#compare-branch-list .compare-branch-item").map((b) => b.dataset.ref);
  assert.deepEqual(names(), ["main", "origin/main", "feature/dropdown", "origin/release-1"]);
  // The repository default is marked, so a long list still says which branch you get by choosing nothing.
  const marked = v.$all("#compare-branch-list .compare-branch-item").filter((b) => b.querySelector(".compare-branch-note"));
  assert.deepEqual(marked.map((b) => b.dataset.ref), ["origin/main"]);

  v.typeInto(v.$("#compare-branch-search"), "feat");
  await v.settle(20);
  assert.deepEqual(names(), ["feature/dropdown"], "the list narrows to the typed text");

  v.$('#compare-branch-list .compare-branch-item[data-ref="feature/dropdown"]')
    .dispatchEvent(new v.window.MouseEvent("click", { bubbles: true }));
  await v.settle(30);
  assert.deepEqual(calls, [["all", "feature/dropdown"]], "a branch pick is an 'all changes vs that branch'");
  v.close();
});

// Two keys naming the two states, not one key toggling between them: a toggle only tells you where you land
// if you already know where you started, and not knowing that is why you reached for the key.
test("Option+A and Option+U pick a mode outright, without opening the menu", async () => {
  const v = await loadViewer(html);
  const calls = installCompareBridge(v);

  v.key("a", { altKey: true, code: "KeyA" });
  await v.settle(30);
  assert.deepEqual(calls, [["all", null]], "Option+A asks for all changes");
  assert.equal(v.$("#compare-menu").classList.contains("hidden"), true, "and nothing opened");

  v.key("a", { altKey: true, code: "KeyA" });
  await v.settle(30);
  assert.deepEqual(calls, [["all", null], ["all", null]], "pressing it again asks for the same thing, not the other one");

  // macOS composes an umlaut on Option+U, so the event arrives with key "Dead" and only `code` identifies it.
  v.key("Dead", { altKey: true, code: "KeyU" });
  await v.settle(30);
  assert.deepEqual(calls.at(-1), ["uncommitted", null], "Option+U asks for uncommitted changes");
  v.close();
});

test("Option+C opens the menu straight at the branch picker", async () => {
  const v = await loadViewer(html);
  installCompareBridge(v);

  v.key("c", { altKey: true, code: "KeyC" });
  await v.settle(40);
  assert.equal(v.$("#compare-menu").classList.contains("hidden"), false, "the menu opened");
  assert.equal(v.$("#compare-menu-branches").classList.contains("hidden"), false, "with the branch list already showing");
  assert.equal(v.document.activeElement.id, "compare-branch-search", "and the filter has the keyboard");
  v.close();
});

test("Escape backs out of the branch panel first, then out of the menu", async () => {
  const v = await loadViewer(html);
  installCompareBridge(v);

  v.$("#compare-pill").dispatchEvent(new v.window.MouseEvent("click", { bubbles: true }));
  await v.settle(30);
  v.$(".compare-menu-branch-open").dispatchEvent(new v.window.MouseEvent("click", { bubbles: true }));
  await v.settle(20);
  assert.equal(v.$("#compare-menu-branches").classList.contains("hidden"), false);

  v.key("Escape");
  await v.settle(10);
  assert.equal(v.$("#compare-menu-branches").classList.contains("hidden"), true, "first Esc closes the branch panel");
  assert.equal(v.$("#compare-menu").classList.contains("hidden"), false, "and leaves the menu up");

  v.key("Escape");
  await v.settle(10);
  assert.equal(v.$("#compare-menu").classList.contains("hidden"), true, "second Esc closes the menu");
  v.close();
});
