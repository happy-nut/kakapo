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
        message: sha === "bbbbbbbb" ? "older commit" : "newer commit\n\nA detailed rationale that should not cover the diff by default.\n\nCo-Authored-By: Reviewer <reviewer@test>",
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
  assert.equal(rows[0].topEdges.length, 0, "a ref tip starts at its commit dot without a dangling line above it");
  assert.equal(rows[0].bottomEdges.length, 2, "merge fans out to two parent lanes");
  assert.ok(rows.maxLane >= 1, "a second lane was opened");
  assert.equal(rows[3].topEdges.length, 1, "the shared ancestor receives one compacted lane after the merge");
  assert.ok(rows[3].bottomEdges.length === 0, "root has no outgoing edge");
  assert.ok(rows[2].bottomEdges.some((edge) => edge.from === 1 && edge.to === 0), "the merged lane curves into the surviving lane immediately");
  v.close();
});

test("history graph: refs use branch and tag chips while merges retain topology", async () => {
  const v = await loadViewer(html);
  v.window.monacoriGit = {
    log: () => Promise.resolve([
      { hash: "mmmmmmmm", parents: ["aaaaaaaa", "bbbbbbbb"], author: "A", email: "a@test", date: "2026-06-04T10:00:00+09:00", refs: "HEAD -> refs/heads/main, tag: refs/tags/v2.0", subject: "Merge topic" },
      { hash: "aaaaaaaa", parents: ["cccccccc"], author: "A", email: "a@test", date: "2026-06-03T10:00:00+09:00", refs: "", subject: "main work" },
      { hash: "bbbbbbbb", parents: ["cccccccc"], author: "B", email: "b@test", date: "2026-06-02T10:00:00+09:00", refs: "refs/remotes/origin/topic", subject: "topic work" },
      { hash: "cccccccc", parents: [], author: "C", email: "c@test", date: "2026-06-01T10:00:00+09:00", refs: "", subject: "root" },
    ]),
    commitDiff: () => Promise.resolve(null),
  };

  v.key("9", { metaKey: true, code: "Digit9" });
  await v.settle(80);

  const merge = v.$('.hrow[data-sha="mmmmmmmm"]');
  assert.ok(merge.classList.contains("merge-commit"), "merge commits have distinct message treatment");
  assert.equal(merge.querySelector(".href-head .href-label").textContent, "main", "HEAD shows its branch target instead of a noisy arrow expression");
  assert.equal(merge.querySelector(".href-head").title, "HEAD → main");
  assert.equal(merge.querySelector(".href-tag .href-label").textContent, "v2.0");
  assert.ok(merge.querySelector(".href-tag .href-icon"), "tags have a dedicated glyph");
  assert.equal(v.$('.hrow[data-sha="bbbbbbbb"] .href-remote .href-label').textContent, "origin/topic");
  assert.ok(v.$all('.hrow[data-sha="mmmmmmmm"] .hgraph path').length >= 2, "merge commit fans into both parent lanes");
  assert.ok(Number.parseFloat(v.window.getComputedStyle(merge).height) >= 26, "graph rows provide enough vertical room for ref chips");
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
  assert.match(css, /body\.native-app\s+\.history-bar\s*\{[^}]*padding-left:\s*var\(--native-title-safe-after-rail\)/, "History title uses the shared macOS traffic-light safe inset");
  assert.equal(v.$("#history-list .hrow.active").dataset.sha, "aaaaaaaa", "newest commit selected");
  assert.equal(v.$("#history-detail").classList.contains("hidden"), true, "commit graph owns the full canvas before Enter");
  assert.deepEqual(calls, [], "opening history does not auto-load a narrow diff preview");

  v.key("ArrowDown");
  await v.settle(20);
  assert.equal(v.$("#history-list .hrow.active").dataset.sha, "bbbbbbbb", "ArrowDown moves through commit history");
  assert.deepEqual(calls, [], "navigation still does not load the commit diff");

  v.key("Enter");
  await v.settle(80);
  assert.deepEqual(calls, ["bbbbbbbb"], "Enter opens the selected commit diff");
  assert.equal(v.$("#history-view").classList.contains("hidden"), false, "floating history view stays open");
  assert.equal(v.$("#history-view").classList.contains("history-diff-open"), true, "commit diff opens as a floating workspace");
  assert.equal(v.$("#history-detail-backdrop").classList.contains("hidden"), false, "floating diff visually separates from the commit graph");
  assert.match(css, /\.history-detail\s*\{[^}]*position:\s*absolute[^}]*inset:\s*clamp/, "diff workspace floats over the full-width commit graph");
  assert.ok(v.$("#history-files .history-file[data-file='src/a.ts']"), "diff workspace includes changed-file list");
  assert.ok(v.$("#history-diff-container .d2h-file-wrapper:not(.df-inactive)"), "diff workspace shows a changed file");

  v.key("Escape");
  await v.settle(20);
  assert.equal(v.$("#history-detail").classList.contains("hidden"), true, "Escape closes only the floating diff first");
  assert.equal(v.$("#history-view").classList.contains("hidden"), false, "commit history remains open after closing its diff");
  v.close();
});

test("right-clicking a Files-mode line number opens that line's Git log", async () => {
  const v = await loadViewer(html);
  const lineCalls = [];
  v.window.monacoriGit = {
    log: () => Promise.reject(new Error("full history should not be loaded")),
    lineLog: (request) => {
      lineCalls.push(request);
      return Promise.resolve([
        { hash: "aaaaaaaa", parents: ["bbbbbbbb"], author: "A", email: "a@test", date: "2026-06-01T10:00:00+09:00", refs: "HEAD -> main", subject: "changed selected line" },
        { hash: "bbbbbbbb", parents: [], author: "B", email: "b@test", date: "2026-05-31T10:00:00+09:00", refs: "", subject: "introduced selected line" },
      ]);
    },
    commitDiff: (sha) => Promise.resolve({
      hash: sha,
      author: "A",
      email: "a@test",
      date: "2026-06-01T10:00:00+09:00",
      refs: "",
      message: "changed selected line",
      diffHtml: build.update.diffContainer,
      isMerge: false,
    }),
  };

  await v.openSourceFile("src/b.ts");
  const gutter = v.$('#source-body .source-row[data-line-index="0"] .num');
  const opened = gutter.dispatchEvent(new v.window.MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    clientX: 44,
    clientY: 80,
  }));
  assert.equal(opened, false, "the custom line-number menu replaces the native context menu");
  assert.equal(v.$("#mc-dropdown .mc-dropdown-item").textContent, "Show Git log for this line");

  v.key("Enter");
  await v.settle(80);
  assert.equal(lineCalls.length, 1);
  assert.equal(lineCalls[0].path, "src/b.ts");
  assert.equal(lineCalls[0].line, 1);
  assert.equal(lineCalls[0].limit, 300);
  assert.equal(v.$("#history-view").classList.contains("hidden"), false, "line history uses the existing History workspace");
  assert.equal(v.$("#history-view .history-title").textContent, "Line history");
  assert.equal(v.$("#history-scope").textContent, "src/b.ts:L1");
  assert.deepEqual(v.$all("#history-list .hrow").map((row) => row.dataset.sha), ["aaaaaaaa", "bbbbbbbb"]);

  v.key("Enter");
  await v.settle(80);
  assert.equal(v.$("#history-files .history-file.active").dataset.file, "src/b.ts", "opening a line-history commit selects the scoped file, not the first changed file");
  v.close();
});

test("history diff workspace: Cmd+0 focuses, collapses, and restores changed files", async () => {
  const v = await loadViewer(html);
  installHistoryBridge(v);

  v.key("9", { metaKey: true, code: "Digit9" });
  await v.settle(80);
  v.key("Enter");
  await v.settle(80);
  assert.equal(v.$("#history-files .history-file.active").dataset.file, "src/a.ts", "first changed file is shown initially");

  v.key("0", { metaKey: true });
  await v.settle(20);
  assert.ok(v.$("#history-files .history-file.tree-focus"), "the first Cmd+0 moves logical focus into changed files");

  v.key("0", { metaKey: true });
  await v.settle(20);
  assert.ok(v.$("#history-detail .history-workspace").classList.contains("history-files-collapsed"), "a repeated Cmd+0 collapses the focused file list");
  assert.equal(v.$("#history-files").getAttribute("aria-hidden"), "true", "the collapsed list leaves keyboard and accessibility navigation");

  v.key("0", { metaKey: true });
  await v.settle(20);
  assert.equal(v.$("#history-detail .history-workspace").classList.contains("history-files-collapsed"), false, "Cmd+0 restores the collapsed file list");
  assert.ok(v.$("#history-files .history-file.tree-focus"), "the restored list owns logical focus");

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

test("long commit messages stay compact until explicitly expanded", async () => {
  const v = await loadViewer(html);
  installHistoryBridge(v);

  v.key("9", { metaKey: true, code: "Digit9" });
  await v.settle(80);
  v.key("Enter");
  await v.settle(80);

  const head = v.$("#history-detail .history-detail-head");
  const body = v.$("#history-message-body");
  const toggle = v.$("#history-message-toggle");
  assert.equal(v.$(".hd-subject").textContent, "newer commit", "only the commit subject occupies the fixed header");
  assert.match(body.textContent, /detailed rationale/, "the complete body remains available");
  assert.equal(v.window.getComputedStyle(body).display, "none", "the long body is collapsed by default");
  assert.equal(toggle.dataset.keyhint, "M", "the disclosure button exposes its keyboard shortcut");
  assert.ok(v.$("#history-diff-container .d2h-file-wrapper:not(.df-inactive)"), "the reclaimed space belongs to the code diff");

  v.click(toggle);
  await v.settle(20);
  assert.ok(head.classList.contains("message-expanded"), "mouse click expands the message on demand");
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  assert.equal(v.window.getComputedStyle(body).display, "block");

  v.key("m");
  await v.settle(20);
  assert.equal(head.classList.contains("message-expanded"), false, "M collapses the message again");
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  v.close();
});
