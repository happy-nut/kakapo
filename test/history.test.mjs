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
  v.window.kakapoGit = {
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
  v.window.kakapoGit = {
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
  assert.equal(v.$all("#history-diff-container .d2h-file-wrapper:not(.df-inactive) .mc-layered-diff-side").length, 2, "commit diff reuses both Review editor panes");
  assert.equal(v.$all("#history-diff-container .d2h-file-wrapper:not(.df-inactive) .mc-diff-gutter-layer").length, 2, "commit diff reuses the centre line-number gutters");

  v.key("Escape");
  await v.settle(20);
  assert.equal(v.$("#history-detail").classList.contains("hidden"), true, "Escape closes only the floating diff first");
  assert.equal(v.$("#history-view").classList.contains("hidden"), false, "commit history remains open after closing its diff");
  v.close();
});

test("right-clicking a Files-mode line number shows blame in the gutter and opens its commit diff", async () => {
  const v = await loadViewer(html);
  const blameCalls = [];
  const diffCalls = [];
  v.window.kakapoGit = {
    log: () => Promise.reject(new Error("full history should not be loaded")),
    blame: (request) => {
      blameCalls.push(request);
      return Promise.resolve([
        { line: 1, hash: "aaaaaaaa", author: "Ada Reviewer", date: "2026-06-01", summary: "changed selected line" },
        { line: 2, hash: "cccccccc", author: "Grace Reviewer", date: "2025-06-01", summary: "older stable line" },
      ]);
    },
    commitDiff: (sha) => {
      diffCalls.push(sha);
      return Promise.resolve({
        hash: sha,
        author: "Ada Reviewer",
        email: "a@test",
        date: "2026-06-01T10:00:00+09:00",
        refs: "",
        message: "changed selected line",
        diffHtml: build.update.diffContainer,
        isMerge: false,
      });
    },
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
  assert.equal(v.$("#mc-dropdown .mc-dropdown-item").textContent, "Show date and author");

  v.key("Enter");
  await v.settle(80);
  assert.equal(blameCalls.length, 1);
  assert.equal(blameCalls[0].path, "src/b.ts");
  assert.equal(v.$("#history-view").classList.contains("hidden"), true, "blame does not replace the current file with a history panel");
  assert.ok(v.$("#source-body").classList.contains("source-blame-visible"));
  assert.equal(v.$('.source-row[data-line-index="0"] .source-line-number').textContent, "1");
  assert.equal(v.$('.source-row[data-line-index="0"] .source-blame-date').textContent, "2026-06-01");
  assert.equal(v.$('.source-row[data-line-index="0"] .source-blame-author').textContent, "Ada Reviewer");
  assert.ok(v.$('.source-row[data-line-index="0"] .source-blame-entry').classList.contains('mc-blame-age-0'), "newest source attribution uses the clearest age color");
  assert.ok(v.$('.source-row[data-line-index="1"] .source-blame-entry').classList.contains('mc-blame-age-4'), "oldest source attribution uses the most muted age color");
  const sourceBlameCell = v.$('.source-row[data-line-index="0"] .num');
  assert.ok(
    sourceBlameCell.querySelector('.source-blame-entry').compareDocumentPosition(sourceBlameCell.querySelector('.source-line-number'))
      & v.window.Node.DOCUMENT_POSITION_FOLLOWING,
    "date and author precede the line number so the number remains adjacent to source code",
  );

  v.$('.source-row[data-line-index="0"] [data-blame-sha]').click();
  await v.settle(80);
  assert.deepEqual(diffCalls, ["aaaaaaaa"]);
  assert.equal(v.$("#history-view").classList.contains("hidden"), false, "clicking date/author opens the corresponding commit diff");
  assert.equal(v.$("#history-files .history-file.active").dataset.file, "src/b.ts", "the clicked attribution selects that file inside the commit diff");
  const sourceCommitWrapper = v.$("#history-diff-container .d2h-file-wrapper:not(.df-inactive)");
  assert.equal(sourceCommitWrapper.querySelectorAll('.mc-layered-diff-side').length, 2, "annotation navigation still opens the shared Review diff renderer");
  assert.equal(sourceCommitWrapper.classList.contains('mc-diff-blame-visible'), false, "annotation navigation opens the commit diff with annotations closed");
  assert.equal(sourceCommitWrapper.querySelector('.mc-diff-blame-entry'), null, "the commit diff does not inherit source annotation cells");

  v.key("Escape");
  assert.equal(v.$("#history-view").classList.contains("hidden"), true, "closing a directly opened commit returns to the source file");
  v.close();
});

test("right-clicking a diff line number loads both revisions and keeps numbers against their code panes", async () => {
  const v = await loadViewer(html);
  const wrapper = v.$('#diff2html-container .d2h-file-wrapper:not(.df-inactive)');
  const sides = wrapper.querySelectorAll('.d2h-file-side-diff');
  const oldItem = sides[0].querySelector('.mc-diff-gutter-number');
  const newItem = sides[1].querySelector('.mc-diff-gutter-number');
  const oldLine = Number(oldItem.textContent.trim());
  const newLine = Number(newItem.textContent.trim());
  const calls = [];
  v.window.kakapoGit = {
    blame: (request) => {
      calls.push(request);
      return Promise.resolve([{
        line: request.side === 'old' ? oldLine : newLine,
        hash: request.side === 'old' ? 'aaaaaaaa' : 'bbbbbbbb',
        author: request.side === 'old' ? 'Base Author' : 'Working Author',
        date: request.side === 'old' ? '2026-05-01' : '2026-07-18',
        summary: 'line attribution',
      }]);
    },
    commitDiff: (sha) => Promise.resolve({
      hash: sha,
      author: 'Working Author',
      email: 'working@test',
      date: '2026-07-18T10:00:00+09:00',
      refs: '',
      message: 'line attribution',
      diffHtml: build.update.diffContainer,
      isMerge: false,
    }),
  };

  const opened = oldItem.dispatchEvent(new v.window.MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
    clientX: 0,
    clientY: 0,
  }));
  assert.equal(opened, false, 'diff line numbers use the inline blame menu');
  assert.equal(v.$('#mc-dropdown .mc-dropdown-item').textContent, 'Show date and author');
  v.key('Enter');
  await v.settle(80);

  assert.equal(calls.length, 2);
  assert.equal(calls[0].path, 'src/a.ts');
  assert.equal(calls[0].side, 'old');
  assert.equal(calls[1].path, 'src/a.ts');
  assert.equal(calls[1].side, 'new');
  assert.ok(wrapper.classList.contains('mc-diff-blame-visible'));
  const paintedOld = sides[0].querySelector('.mc-diff-gutter-number');
  const paintedNew = sides[1].querySelector('.mc-diff-gutter-number');
  assert.equal(paintedOld.querySelector('.mc-diff-line-number').textContent, String(oldLine));
  assert.equal(paintedNew.querySelector('.mc-diff-line-number').textContent, String(newLine));
  assert.ok(paintedOld.querySelector('.mc-diff-blame-entry').classList.contains('mc-blame-age-4'), 'older base attribution receives the oldest age bucket');
  assert.ok(paintedNew.querySelector('.mc-diff-blame-entry').classList.contains('mc-blame-age-0'), 'newer working attribution receives the newest age bucket');
  assert.ok(
    paintedOld.querySelector('.mc-diff-line-number').compareDocumentPosition(paintedOld.querySelector('.mc-diff-blame-entry'))
      & v.window.Node.DOCUMENT_POSITION_FOLLOWING,
    'base order is code, line number, date, author',
  );
  assert.ok(
    paintedNew.querySelector('.mc-diff-blame-entry').compareDocumentPosition(paintedNew.querySelector('.mc-diff-line-number'))
      & v.window.Node.DOCUMENT_POSITION_FOLLOWING,
    'working-tree order is date, author, line number, code',
  );
  paintedNew.querySelector('[data-blame-sha]').click();
  await v.settle(80);
  const diffCommitWrapper = v.$('#history-diff-container .d2h-file-wrapper:not(.df-inactive)');
  assert.equal(diffCommitWrapper.querySelectorAll('.mc-layered-diff-side').length, 2, 'diff annotation navigation reuses the centre-gutter Review renderer');
  assert.equal(diffCommitWrapper.classList.contains('mc-diff-blame-visible'), false, 'the destination commit diff starts with annotation closed even for the same path');
  assert.equal(diffCommitWrapper.querySelector('.mc-diff-blame-entry'), null, 'no blame cells leak into the destination commit diff');
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
  const close = v.$("#history-detail-close");
  assert.equal(v.$(".hd-subject").textContent, "newer commit", "only the commit subject occupies the fixed header");
  assert.match(body.textContent, /detailed rationale/, "the complete body remains available");
  assert.equal(v.window.getComputedStyle(body).display, "none", "the long body is collapsed by default");
  assert.equal(toggle.dataset.keyhint, "M", "the disclosure button exposes its keyboard shortcut");
  assert.ok(toggle.querySelector("svg.history-message-chevron"), "the disclosure uses a baseline-stable SVG icon");
  assert.ok(close.querySelector("svg"), "the close action uses the same SVG icon system");
  assert.equal(v.window.getComputedStyle(toggle).height, v.window.getComputedStyle(close).height, "header actions share one button height");
  assert.ok(v.$("#history-diff-container .d2h-file-wrapper:not(.df-inactive)"), "the reclaimed space belongs to the code diff");

  v.click(toggle);
  await v.settle(20);
  assert.ok(head.classList.contains("message-expanded"), "mouse click expands the message on demand");
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  assert.equal(v.window.getComputedStyle(body).display, "block");

  // History owns its keys even if Chromium left focus outside the floating detail. event.code keeps the
  // physical M binding working under a Korean input source, where event.key is the Hangul glyph `ㅡ`.
  v.document.body.dispatchEvent(new v.window.KeyboardEvent("keydown", {
    key: "ㅡ", code: "KeyM", bubbles: true, cancelable: true,
  }));
  await v.settle(20);
  assert.equal(head.classList.contains("message-expanded"), false, "physical M collapses the message regardless of DOM focus or input source");
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  v.close();
});
