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

function installCompareBridge(v, state = {}) {
  const calls = [];
  const data = {
    mode: "uncommitted",
    ref: "origin/main",
    defaultRef: "origin/main",
    branches: ["main", "origin/main", "feature/dropdown", "origin/release-1"],
    remotes: ["origin"],
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
  assert.deepEqual(rows.map((r) => r.dataset.mode), ["since", "all", "uncommitted", "tip"]);
  assert.equal(rows[0].classList.contains("hidden"), true, "no hand-off yet, so nothing to read since one");
  assert.equal(rows[2].getAttribute("aria-checked"), "true", "the row the review is on is the checked one");
  assert.deepEqual(rows.filter((r) => r.getAttribute("aria-checked") === "true").map((r) => r.dataset.mode),
    ["uncommitted"], "exactly one row is checked");
  assert.match(v.$("#compare-menu-against").textContent, /origin\/main/, "the 'all' row names what it compares against");
  v.close();
});

test("the tip row is the checked one when that is the question the review is asking", async () => {
  const v = await loadViewer(html);
  const calls = installCompareBridge(v, { mode: "tip", ref: "origin/main", defaultRef: "origin/main", pinned: true });

  v.$("#compare-pill").dispatchEvent(new v.window.MouseEvent("click", { bubbles: true }));
  await v.settle(30);
  const rows = v.$all("#compare-menu .compare-menu-row[data-mode]");
  assert.deepEqual(rows.filter((r) => r.getAttribute("aria-checked") === "true").map((r) => r.dataset.mode),
    ["tip"], "the tip row, and only it");

  v.$('#compare-menu .compare-menu-row[data-mode="all"]').dispatchEvent(new v.window.MouseEvent("click", { bubbles: true }));
  await v.settle(30);
  assert.deepEqual(calls, [["all", null]], "switching away from tip reaches main as its own mode");
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

async function openBranchNamed(v, query) {
  v.$(".compare-menu-branch-open").dispatchEvent(new v.window.MouseEvent("click", { bubbles: true }));
  await v.settle(30);
  v.typeInto(v.$("#compare-branch-search"), query);
  await v.settle(20);
}

test("the branch panel asks which side first, then lists that side", async () => {
  const v = await loadViewer(html);
  const calls = installCompareBridge(v);

  v.$("#compare-pill").dispatchEvent(new v.window.MouseEvent("click", { bubbles: true }));
  await v.settle(30);
  v.$(".compare-menu-branch-open").dispatchEvent(new v.window.MouseEvent("click", { bubbles: true }));
  await v.settle(20);

  const rows = () => v.$all("#compare-branch-list .compare-branch-item");
  const scopes = () => rows().map((b) => b.dataset.scope).filter(Boolean);
  const names = () => rows().map((b) => b.dataset.ref).filter(Boolean);

  assert.deepEqual(scopes(), ["local", "origin"], "the first stage is the two sides, local first");
  assert.deepEqual(names(), [], "and nothing is listed yet");
  assert.match(rows()[0].querySelector(".compare-branch-note").textContent, /2/,
    "the local row says how many it holds");

  rows()[1].dispatchEvent(new v.window.MouseEvent("click", { bubbles: true }));
  await v.settle(20);
  assert.deepEqual(names(), ["origin/main", "origin/release-1"],
    "the second stage is that side only — a local branch here would be the flat list again");
  assert.deepEqual(rows().filter((b) => b.querySelector(".compare-branch-note")).map((b) => b.dataset.ref),
    ["origin/main"]);

  v.$("#compare-branch-list .compare-branch-item[data-back]")
    .dispatchEvent(new v.window.MouseEvent("click", { bubbles: true }));
  await v.settle(20);
  assert.deepEqual(scopes(), ["local", "origin"], "back returns to the question");

  v.typeInto(v.$("#compare-branch-search"), "feat");
  await v.settle(20);
  assert.deepEqual(names(), ["feature/dropdown"], "the list narrows to the typed text, from any side");
  assert.deepEqual(v.$all("#compare-branch-list .compare-branch-item[data-back]"), [],
    "and a search result has no side to go back to");

  v.$('#compare-branch-list .compare-branch-item[data-ref="feature/dropdown"]')
    .dispatchEvent(new v.window.MouseEvent("click", { bubbles: true }));
  await v.settle(30);
  assert.deepEqual(calls, [["all", "feature/dropdown"]], "a branch pick is an 'all changes vs that branch'");
  v.close();
});

test("Option+A and Option+U pick a mode outright, without opening the menu", async () => {
  const v = await loadViewer(html);
  const calls = installCompareBridge(v);

  v.key("a", { altKey: true, code: "KeyA" });
  await v.settle(30);
  assert.deepEqual(calls, [["all", null]], "Option+A asks for all changes");
  assert.equal(v.$("#compare-menu").classList.contains("hidden"), true, "and nothing opened");

  v.$all("#mc-toasts .mc-toast").forEach((toast) => toast.remove());
  v.key("a", { altKey: true, code: "KeyA" });
  await v.settle(30);
  assert.deepEqual(calls, [["all", null]], "and does not rebuild for the mode it is already in");
  assert.match(v.$("#mc-toasts").textContent, /All changes|모든 변경/,
    "while still saying which mode that is");

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

test("the bar's “all” does nothing when it is already in force, and switches when it is not", async () => {
  const v = await loadViewer(html);
  try {
    const calls = [];
    v.window.kakapoGit = {
      compareMenu: () => Promise.resolve({ mode: "all", ref: "main", defaultRef: "main", branches: ["main"] }),
      setCompareMode: (mode, ref) => { calls.push(["setCompareMode", mode, ref || ""]); return Promise.resolve({ ok: true, mode, ref: "main" }); },
      setReviewBase: (ref) => { calls.push(["setReviewBase", ref]); return Promise.resolve({ ok: true, activeBase: ref }); },
      setReviewTarget: (ref) => { calls.push(["setReviewTarget", ref]); return Promise.resolve({ ok: true, activeTarget: ref }); },
    };
    const setBar = (activeBase) => v.window.eval(`patchSetData = ${JSON.stringify({
      branchPoint: { sha: "54d784f0000", label: "main" },
      commits: [{ sha: "1fe2700", subject: "work", shortSha: "1fe2700", date: "" }],
      scoped: false, activeBase, activeTarget: "worktree",
    })}, 1`);

    setBar("54d784f0000");
    v.window.selectPatchSet("base", "auto");
    await v.settle(20);
    assert.deepEqual(calls, [], "clicking the option already in force asks for no rebuild");

    setBar("1fe2700");
    v.window.selectPatchSet("base", "auto");
    await v.settle(20);
    assert.deepEqual(calls, [["setCompareMode", "all", ""]],
      "and it goes the compare-mode way, which resolves the branch point explicitly");
  } finally {
    v.close();
  }
});

test("a failed switch can be tried again", async () => {
  const v = await loadViewer(html);
  try {
    const calls = [];
    let fail = true;
    v.window.kakapoGit = {
      compareMenu: () => Promise.resolve({ mode: "uncommitted", ref: "origin/main", defaultRef: "origin/main", branches: ["main"] }),
      setCompareMode: (mode, ref) => {
        calls.push([mode, ref ?? null]);
        return Promise.resolve(fail ? { ok: false, error: "git exploded" } : { ok: true, mode, ref: "origin/main" });
      },
    };
    await v.window.__kakapoCompareMenu.refresh();
    await v.settle(20);
    assert.equal(v.window.eval("compareMenuState.mode"), "uncommitted", "the premise: the review is on uncommitted");

    v.window.__kakapoCompareMenu.pick("all");
    await v.settle(30);
    assert.equal(calls.length, 1, "the switch was asked for");
    assert.equal(v.window.eval("compareMenuState.mode"), "uncommitted",
      "and the tick came back off, because the review did not move");

    fail = false;
    v.window.__kakapoCompareMenu.pick("all");
    await v.settle(30);
    assert.equal(calls.length, 2, "so the retry reaches the backend instead of being screened as a no-op");
    assert.equal(v.window.eval("compareMenuState.mode"), "all", "and this one took");

    v.window.__kakapoCompareMenu.pick("all");
    await v.settle(30);
    assert.equal(calls.length, 2, "no rebuild for a state that does not change");
  } finally {
    v.close();
  }
});

test("picking the branch the review already defaults to records the choice", async () => {
  const v = await loadViewer(html);
  const calls = installCompareBridge(v, { mode: "all", ref: "origin/main", defaultRef: "origin/main", pinned: false });

  v.$("#compare-pill").dispatchEvent(new v.window.MouseEvent("click", { bubbles: true }));
  await v.settle(30);
  await openBranchNamed(v, "origin/main");
  const marked = v.$all(".compare-branch-item").find((b) => b.dataset.ref === "origin/main");
  assert.ok(marked, "the default branch is in the list");
  marked.dispatchEvent(new v.window.MouseEvent("click", { bubbles: true }));
  await v.settle(30);

  assert.deepEqual(calls, [["all", "origin/main"]],
    "the pick reached main, which is the only thing that persists it");
  v.close();
});

test("picking the branch already recorded is still screened from the rebuild", async () => {
  const v = await loadViewer(html);
  const calls = installCompareBridge(v, { mode: "all", ref: "origin/main", defaultRef: "origin/main", pinned: true });

  v.$("#compare-pill").dispatchEvent(new v.window.MouseEvent("click", { bubbles: true }));
  await v.settle(30);
  await openBranchNamed(v, "origin/main");
  const marked = v.$all(".compare-branch-item").find((b) => b.dataset.ref === "origin/main");
  marked.dispatchEvent(new v.window.MouseEvent("click", { bubbles: true }));
  await v.settle(30);

  assert.deepEqual(calls, [], "no rebuild for a pick that is already on record");
  assert.equal(v.$("#compare-menu").classList.contains("hidden"), true, "and the menu still closes");
  v.close();
});

test("the optimistic pin does not screen a pick of a different branch", async () => {
  const v = await loadViewer(html);
  const calls = installCompareBridge(v, { mode: "all", ref: "origin/main", defaultRef: "origin/main", pinned: false });

  v.$("#compare-pill").dispatchEvent(new v.window.MouseEvent("click", { bubbles: true }));
  await v.settle(30);
  await openBranchNamed(v, "origin/main");
  v.$all(".compare-branch-item").find((b) => b.dataset.ref === "origin/main")
    .dispatchEvent(new v.window.MouseEvent("click", { bubbles: true }));
  await v.settle(30);

  v.$("#compare-pill").dispatchEvent(new v.window.MouseEvent("click", { bubbles: true }));
  await v.settle(30);
  await openBranchNamed(v, "feature/dropdown");
  const other = v.$all(".compare-branch-item").find((b) => b.dataset.ref === "feature/dropdown");
  assert.ok(other, "a second branch is in the list");
  other.dispatchEvent(new v.window.MouseEvent("click", { bubbles: true }));
  await v.settle(30);

  assert.deepEqual(calls, [["all", "origin/main"], ["all", "feature/dropdown"]],
    "both picks reached main");
  v.close();
});

test("the read-mark row appears only once there is a mark, and says how far the branch has moved", async () => {
  const v = await loadViewer(html);
  const calls = installCompareBridge(v, {
    mode: "uncommitted",
    readMark: { sha: "f".repeat(40), shortSha: "fffffff", commits: 3 },
  });

  v.$("#compare-pill").dispatchEvent(new v.window.MouseEvent("click", { bubbles: true }));
  await v.settle(30);
  const row = v.$('#compare-menu .compare-menu-row[data-mode="since"]');
  assert.equal(row.classList.contains("hidden"), false, "a mark exists, so the row is offered");
  assert.match(v.$("#compare-menu-since-note").textContent, /3/, "and says how many commits arrived");

  row.dispatchEvent(new v.window.MouseEvent("click", { bubbles: true }));
  await v.settle(30);
  assert.deepEqual(calls, [["since", null]], "the pick reaches main as its own mode");
  v.close();
});

test("the read-mark row is the checked one while the review is measured from the mark", async () => {
  const v = await loadViewer(html);
  installCompareBridge(v, {
    mode: "since",
    readMark: { sha: "f".repeat(40), shortSha: "fffffff", commits: 1 },
  });

  v.$("#compare-pill").dispatchEvent(new v.window.MouseEvent("click", { bubbles: true }));
  await v.settle(30);
  assert.deepEqual(
    v.$all("#compare-menu .compare-menu-row[data-mode]")
      .filter((r) => r.getAttribute("aria-checked") === "true").map((r) => r.dataset.mode),
    ["since"], "the since row, and only it");
  v.close();
});

test("Option+N with no mark says why instead of doing nothing", async () => {
  const v = await loadViewer(html);
  const calls = installCompareBridge(v);

  v.key("Dead", { altKey: true, code: "KeyN" });
  await v.settle(30);
  assert.deepEqual(calls, [], "nothing was asked of main");
  assert.match(v.$("#mc-toasts").textContent, /hand-off|넘기기/, "but the reader is told why");
  v.close();
});

test("Option+N asks for the mark when there is one", async () => {
  const v = await loadViewer(html);
  const calls = installCompareBridge(v, {
    readMark: { sha: "f".repeat(40), shortSha: "fffffff", commits: 2 },
  });

  v.key("Dead", { altKey: true, code: "KeyN" });
  await v.settle(40);
  assert.deepEqual(calls, [["since", null]], "and nothing had to be opened to get there");
  assert.equal(v.$("#compare-menu").classList.contains("hidden"), true);
  v.close();
});
