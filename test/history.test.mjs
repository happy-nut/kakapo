// CORE: the git-history (Cmd+9) graph-lane layout. computeHistoryGraph turns commits + parents into
// per-row lanes/edges; these guard the two cases that matter — a linear chain stays in one lane, and a
// merge opens a second lane that collapses back at the shared ancestor.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeReviewHtml, cleanupFixtures } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";

let html;
let build;
before(async () => {
  ({ html, build } = await makeReviewHtml([
    { path: "src/a.ts", before: "export const a = 1;\n", after: "export const a = 2;\n" },
    { path: "src/b.ts", before: "export const b = 1;\n", after: "export const b = 2;\n" },
  ], { app: true }));
});
after(cleanupFixtures);

function installHistoryBridge(v) {
  const calls = [];
  v.window.monacoriGit = {
    log: () => Promise.resolve([
      { hash: "aaaaaaaa", parents: ["bbbbbbbb"], author: "A", email: "a@test", date: "2026-06-01T10:00:00+09:00", refs: "HEAD -> main", subject: "newer commit" },
      { hash: "bbbbbbbb", parents: [], author: "B", email: "b@test", date: "2026-05-31T10:00:00+09:00", refs: "", subject: "older commit" },
    ]),
    commitDiff: (sha) => {
      calls.push(sha);
      return Promise.resolve({
        hash: sha,
        author: "A",
        email: "a@test",
        date: "2026-06-01T10:00:00+09:00",
        refs: "",
        message: sha === "bbbbbbbb" ? "older commit" : "newer commit",
        diffHtml: build.update.diffContainer,
        isMerge: false,
      });
    },
  };
  return calls;
}

test("history graph: a linear chain stays in one lane and one color", async () => {
  const v = await loadViewer(html);
  const rows = v.window.computeHistoryGraph([
    { hash: "a", parents: ["b"] },
    { hash: "b", parents: ["c"] },
    { hash: "c", parents: [] },
  ]);
  assert.equal(rows.length, 3);
  assert.ok(rows.every((r) => r.myLane === 0), "every commit sits in lane 0");
  assert.ok(rows.every((r) => r.color === 0), "one color down the chain");
  assert.equal(rows.maxLane, 0, "no extra lanes");
  v.close();
});

test("history graph: a merge opens a 2nd lane that collapses at the shared ancestor", async () => {
  const v = await loadViewer(html);
  const rows = v.window.computeHistoryGraph([
    { hash: "m", parents: ["a", "b"] }, // merge of a and b
    { hash: "a", parents: ["c"] },
    { hash: "b", parents: ["c"] },
    { hash: "c", parents: [] }, // shared ancestor
  ]);
  assert.equal(rows[0].myLane, 0, "merge commit on lane 0");
  assert.equal(rows[0].bottomEdges.length, 2, "merge fans out to two parent lanes");
  assert.ok(rows.maxLane >= 1, "a second lane was opened");
  assert.ok(rows[3].topEdges.length >= 2, "both lanes merge back into the root commit");
  assert.ok(rows[3].bottomEdges.length === 0, "root has no outgoing edge");
  v.close();
});

test("history keyboard: Cmd+9 then ArrowDown navigates commits before opening a diff", async () => {
  const v = await loadViewer(html);
  const calls = installHistoryBridge(v);

  v.key("9", { metaKey: true, code: "Digit9" });
  await v.settle(80);
  assert.equal(v.$("#history-view").classList.contains("hidden"), false, "history overlay opens");
  assert.equal(v.window.getComputedStyle(v.$(".activity-rail")).display, "flex", "activity rail remains visible beside History");
  assert.ok(v.$('.rail-btn[data-view="history"]').classList.contains("is-active"), "History remains represented by its active rail icon");
  const css = Array.from(v.document.querySelectorAll("style"), (style) => style.textContent || "").join("\n");
  assert.match(css, /\.history-view\s*\{[^}]*inset:\s*0 0 0 var\(--rail-width\)/, "History starts after the desktop rail");
  assert.equal(v.$("#history-list .hrow.active").dataset.sha, "aaaaaaaa", "newest commit selected");
  assert.deepEqual(calls, [], "opening history does not auto-load a narrow diff preview");

  v.key("ArrowDown");
  await v.settle(20);
  assert.equal(v.$("#history-list .hrow.active").dataset.sha, "bbbbbbbb", "ArrowDown moves through commit history");
  assert.deepEqual(calls, [], "navigation still does not load the commit diff");

  v.key("Enter");
  await v.settle(80);
  assert.deepEqual(calls, ["bbbbbbbb"], "Enter opens the selected commit diff");
  assert.equal(v.$("#history-view").classList.contains("hidden"), false, "floating history view stays open");
  assert.ok(v.$("#history-files .history-file[data-file='src/a.ts']"), "diff workspace includes changed-file list");
  assert.ok(v.$("#history-diff-container .d2h-file-wrapper:not(.df-inactive)"), "diff workspace shows a changed file");
  v.close();
});

test("history diff workspace: Cmd+0 focuses changed files and Enter opens that file in-place", async () => {
  const v = await loadViewer(html);
  installHistoryBridge(v);

  v.key("9", { metaKey: true, code: "Digit9" });
  await v.settle(80);
  v.key("Enter");
  await v.settle(80);
  assert.equal(v.$("#history-files .history-file.active").dataset.file, "src/a.ts", "first changed file is shown initially");

  v.key("0", { metaKey: true });
  await v.settle(20);
  v.key("ArrowDown");
  await v.settle(20);
  assert.equal(v.$("#history-files .history-file.tree-focus").dataset.file, "src/b.ts", "ArrowDown moves in the history changed-file list");
  v.key("Enter");
  await v.settle(40);

  assert.equal(v.$("#history-files .history-file.active").dataset.file, "src/b.ts", "Enter opens the focused changed file");
  const visible = v.$all("#history-diff-container .d2h-file-wrapper").filter((w) => !w.classList.contains("df-inactive"));
  assert.equal(visible.length, 1, "history diff shows one changed file, not the whole commit diff");
  assert.equal(visible[0].dataset.path, "src/b.ts");

  v.key("F7");
  await v.settle(40);
  assert.equal(v.$("#history-files .history-file.active").dataset.file, "src/a.ts", "F7 navigates hunks inside the history diff workspace");
  v.close();
});
