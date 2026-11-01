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

  // Not a toggle: pressing it again is still "all changes", never the other mode. It no longer asks the
  // backend a second time — rebuilding the review for the state it is already in costs a git diff and a
  // source re-index — but it still ANSWERS, because the toast is the only thing a keyboard press shows
  // and these are two keys rather than one toggle precisely so the reader can ask where they are.
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

// The bar's "전체" and the menu's "모든 변경사항" are the same thing and now take the same route — but the
// route has to run BELOW the "already there?" guard, not above it. `auto` is produced by that one option
// and nothing else, so a branch placed in front of the guard means the guard was written for a ref it can
// never see: clicking the option already in force ran a full rebuild, a git diff and a source re-index,
// for a state that did not change. Asserted by counting calls rather than by reading the source, because
// the defect was WHERE the branch sat and a regex over the bundle cannot see that.
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

    // The review is AT the branch point, so "all" is the option already in force.
    setBar("54d784f0000");
    v.window.selectPatchSet("base", "auto");
    await v.settle(20);
    assert.deepEqual(calls, [], "clicking the option already in force asks for no rebuild");

    // Now the review is on a patch set, so the same click is a real change.
    setBar("1fe2700");
    v.window.selectPatchSet("base", "auto");
    await v.settle(20);
    assert.deepEqual(calls, [["setCompareMode", "all", ""]],
      "and it goes the compare-mode way, which resolves the branch point explicitly");
  } finally {
    v.close();
  }
});

// The row ticks before the rebuild answers, because a rebuild can take a second on a large tree. That
// optimism became load-bearing the moment a no-op guard started reading the same state: a failed call
// left it claiming a mode the review never reached, so the guard answered the reader's retry with
// silence — the one press that had to work after a failure was the one that could not.
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

    // …while a press on the mode the review IS in is still screened.
    v.window.__kakapoCompareMenu.pick("all");
    await v.settle(30);
    assert.equal(calls.length, 2, "no rebuild for a state that does not change");
  } finally {
    v.close();
  }
});

// The branch list marks one row as the repository's default, and until anyone picks a branch the effective
// ref IS that default. So a click on the marked row matched the no-op guard's equality check and was
// screened — the menu closed, nothing reached set-compare-mode, and `state.compareRef` was never written.
//
// Screening it is right once the branch is recorded and wrong before: the reader's explicit choice of the
// branch they were already on left no trace, and the next time the automatic answer moved — an upstream
// appears, the default branch is renamed — the review moved off it with no record that it had been chosen.
// `pinned` is the fact main has that the renderer did not.
test("picking the branch the review already defaults to records the choice", async () => {
  const v = await loadViewer(html);
  // mode 'all' on origin/main, arrived at by resolution rather than by a pick: pinned is false.
  const calls = installCompareBridge(v, { mode: "all", ref: "origin/main", defaultRef: "origin/main", pinned: false });

  v.$("#compare-pill").dispatchEvent(new v.window.MouseEvent("click", { bubbles: true }));
  await v.settle(30);
  v.$(".compare-menu-branch-open").dispatchEvent(new v.window.MouseEvent("click", { bubbles: true }));
  await v.settle(30);
  const marked = v.$all(".compare-branch-item").find((b) => b.dataset.ref === "origin/main");
  assert.ok(marked, "the default branch is in the list");
  marked.dispatchEvent(new v.window.MouseEvent("click", { bubbles: true }));
  await v.settle(30);

  assert.deepEqual(calls, [["all", "origin/main"]],
    "the pick reached main, which is the only thing that persists it");
  v.close();
});

test("picking the branch already recorded is still screened from the rebuild", async () => {
  // The other half, and the behaviour the guard exists for: a rebuild is a git diff plus a source re-index,
  // and asking for the state you are already in should not cost one. `pinned` is what separates the two.
  const v = await loadViewer(html);
  const calls = installCompareBridge(v, { mode: "all", ref: "origin/main", defaultRef: "origin/main", pinned: true });

  v.$("#compare-pill").dispatchEvent(new v.window.MouseEvent("click", { bubbles: true }));
  await v.settle(30);
  v.$(".compare-menu-branch-open").dispatchEvent(new v.window.MouseEvent("click", { bubbles: true }));
  await v.settle(30);
  const marked = v.$all(".compare-branch-item").find((b) => b.dataset.ref === "origin/main");
  marked.dispatchEvent(new v.window.MouseEvent("click", { bubbles: true }));
  await v.settle(30);

  assert.deepEqual(calls, [], "no rebuild for a pick that is already on record");
  assert.equal(v.$("#compare-menu").classList.contains("hidden"), true, "and the menu still closes");
  v.close();
});

// A second pick, of a DIFFERENT branch, still has to go through — the optimistic pin must not make the
// guard screen it. This is the failure mode the optimistic update introduced the last time it was added.
test("the optimistic pin does not screen a pick of a different branch", async () => {
  const v = await loadViewer(html);
  const calls = installCompareBridge(v, { mode: "all", ref: "origin/main", defaultRef: "origin/main", pinned: false });

  v.$("#compare-pill").dispatchEvent(new v.window.MouseEvent("click", { bubbles: true }));
  await v.settle(30);
  v.$(".compare-menu-branch-open").dispatchEvent(new v.window.MouseEvent("click", { bubbles: true }));
  await v.settle(30);
  v.$all(".compare-branch-item").find((b) => b.dataset.ref === "origin/main")
    .dispatchEvent(new v.window.MouseEvent("click", { bubbles: true }));
  await v.settle(30);

  v.$("#compare-pill").dispatchEvent(new v.window.MouseEvent("click", { bubbles: true }));
  await v.settle(30);
  v.$(".compare-menu-branch-open").dispatchEvent(new v.window.MouseEvent("click", { bubbles: true }));
  await v.settle(30);
  const other = v.$all(".compare-branch-item").find((b) => b.dataset.ref === "feature/dropdown");
  assert.ok(other, "a second branch is in the list");
  other.dispatchEvent(new v.window.MouseEvent("click", { bubbles: true }));
  await v.settle(30);

  assert.deepEqual(calls, [["all", "origin/main"], ["all", "feature/dropdown"]],
    "both picks reached main");
  v.close();
});
