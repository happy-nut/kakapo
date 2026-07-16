// CORE USER FLOW: lazy-LOAD source view (big repos / serve / Electron).
//
// In lazy-LOAD the standalone HTML ships source metadata only (no content); the body is fetched on demand
// via window.kakapoFile.getSource(path). This guards the critical regression where one file's content
// rendered under another file's path because the caret fast-path trusted metadata over the painted body —
// fixed by tracking sourceBodyPath (the path actually painted) and re-rendering on mismatch.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeReviewHtml, cleanupFixtures, renderLazyBodies } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";

let html, lazySourceData;
before(async () => {
  const r = await makeReviewHtml(
    [
      { path: "src/one.ts", before: "export const one = 1;\n", after: "export const one = 11;\n" },
      { path: "src/two.ts", before: "export const two = 2;\n", after: "export const two = 22;\n" },
    ],
    { lazyLoad: true },
  );
  html = r.html;
  lazySourceData = r.build.lazySourceData;
});
after(cleanupFixtures);

test("lazy-LOAD build keeps initial diff bodies as raw chunks, not pre-rendered HTML", async () => {
  const marker = "KAKAPO_LAZY_BODY_SENTINEL";
  const r = await makeReviewHtml(
    [{ path: "src/lazy.ts", before: "export const lazy = 1;\n", after: `export const lazy = "${marker}";\n` }],
    { lazyLoad: true },
  );
  assert.equal((r.build.lazyBodies || []).length, 0, "transport lazy-load must not pre-render every diff body at build time");
  assert.equal((r.build.lazyBodyDiffs || []).length, 1, "raw per-file diff is retained for on-demand rendering");
  assert.match(r.build.lazyBodyDiffs[0], new RegExp(marker), "raw diff chunk contains the changed line");
  assert.doesNotMatch(r.build.lazyBodyDiffs[0], /d2h-file-wrapper/, "raw chunk is not diff2html markup");
});

test("lazy-LOAD: initial HTML omits unchanged project metadata and loads it on demand", async () => {
  const r = await makeReviewHtml([
    { path: "src/changed.ts", before: "export const changed = 1;\n", after: "export const changed = 2;\n" },
    { path: "src/unchanged.ts", before: "export const stable = true;\n", after: "export const stable = true;\n" },
  ], { lazyLoad: true });
  assert.match(r.html, /src\/changed\.ts/, "changed-file metadata remains available for immediate diff navigation");
  assert.doesNotMatch(r.html, /src\/unchanged\.ts/, "unchanged project records stay out of the startup document");
  assert.doesNotMatch(r.html, /id="files-tree-html"/, "transport reviews do not embed a multi-megabyte inert tree");

  const v = await loadViewer(r.html, { lazySourceData: r.build.lazySourceData });
  v.click(v.$('[data-tab="files"]'));
  await v.settle(100);
  assert.equal(v.window.__projectIndexRequests, 1, "Files requests the project index once");
  assert.equal(v.$('[data-source-file="src/unchanged.ts"]'), null, "collapsed folders do not create all descendant DOM rows");
  v.window.openVirtualSourceDirectory("src");
  await v.settle(20);
  assert.ok(v.$('[data-source-file="src/unchanged.ts"]'), "the deferred tree contains unchanged project files");
  v.close();
});

test("lazy-LOAD: source view renders each file's OWN content after async fetch", async () => {
  const v = await loadViewer(html, { lazySourceData });
  await v.openSourceFile("src/two.ts");
  await v.settle(150); // per-file source fetch resolves async, then re-opens the file with content
  assert.match(v.$("#source-title").textContent, /two\.ts/, "breadcrumb is src/two.ts");
  assert.match(v.$("#source-body").textContent, /export const two = 22/, "body shows src/two.ts content");
  assert.doesNotMatch(v.$("#source-body").textContent, /one = 11/, "body does NOT show another file's content");
  assert.deepEqual(v.window.__sourceRequests, ["src/two.ts"], "renderer requests only the opened file");
  v.close();
});

test("lazy-LOAD: switching files shows the new file's content, never a stale body (path↔content fix)", async () => {
  const v = await loadViewer(html, { lazySourceData });
  await v.openSourceFile("src/one.ts");
  await v.settle(150);
  assert.match(v.$("#source-body").textContent, /one = 11/, "src/one.ts content shown");
  await v.openSourceFile("src/two.ts");
  await v.settle(150);
  const body = v.$("#source-body").textContent;
  assert.match(body, /two = 22/, "switched to src/two.ts content");
  assert.doesNotMatch(body, /one = 11/, "stale src/one.ts body is gone (sourceBodyPath guard)");
  v.close();
});

test("lazy-LOAD: an old in-flight source response cannot overwrite a watch refresh", async () => {
  const b1 = await makeReviewHtml(
    [{ path: "src/race.ts", before: "export const race = 1;\n", after: "export const race = 111;\n" }],
    { lazyLoad: true },
  );
  const b2 = await makeReviewHtml(
    [{ path: "src/race.ts", before: "export const race = 1;\n", after: "export const race = 222;\n" }],
    { lazyLoad: true },
  );
  const oldRecord = JSON.parse(b1.build.lazySourceData)[0];
  const newRecord = JSON.parse(b2.build.lazySourceData)[0];
  let resolveOld;
  const oldPending = new Promise((resolve) => { resolveOld = resolve; });
  let calls = 0;
  const v = await loadViewer(b1.html, {
    menuBridge: true,
    sourceBridge: () => (++calls === 1 ? oldPending : newRecord),
  });
  await v.openSourceFile("src/race.ts"); // first request remains in flight
  await v.pushDiffUpdate(b2.build.update); // refresh issues a new-generation request
  await v.settle(100);
  assert.match(v.$("#source-body").textContent, /race = 222/, "new source generation is painted");

  resolveOld(oldRecord); // stale IPC response arrives last
  await v.settle(100);
  assert.match(v.$("#source-body").textContent, /race = 222/, "late old content is ignored");
  assert.doesNotMatch(v.$("#source-body").textContent, /race = 111/);
  v.close();
});

// REGRESSION: a watch refresh (in-place diff update) cleared bodyPromise but NOT bodyCache, which is keyed
// by file INDEX. loadBodyHtml then returned the cached OLD body for the same index, so a working-tree change
// never appeared in the diff until a full reload. applyDiffUpdate must drop bodyCache too.
test("lazy-LOAD: a watch refresh shows the rebuilt diff body, not the cached old one", async () => {
  const b1 = await makeReviewHtml(
    [{ path: "src/live.ts", before: "export const x = 1;\n", after: "export const x = 111;\n" }],
    { lazyLoad: true },
  );
  let bodies = await renderLazyBodies(b1.build);
  const v = await loadViewer(b1.html, {
    menuBridge: true,
    lazySourceData: b1.build.lazySourceData,
    getDiffBody: (idx) => bodies[idx] || "",
  });
  await v.openDiffFor("src/live.ts");
  await v.settle(120);
  assert.match(v.$("#diff2html-container").textContent, /111/, "initial diff body shown");

  // A watch rebuild changes the SAME file again -> a new body for the same index.
  const b2 = await makeReviewHtml(
    [{ path: "src/live.ts", before: "export const x = 1;\n", after: "export const x = 222;\n" }],
    { lazyLoad: true },
  );
  bodies = await renderLazyBodies(b2.build); // the bridge now serves the rebuilt body for that index
  await v.pushDiffUpdate(b2.build.update);
  await v.settle(120);

  const text = v.$("#diff2html-container").textContent;
  assert.match(text, /222/, "rebuilt body shown after the watch refresh");
  assert.doesNotMatch(text, /111/, "stale cached body is gone");
  v.close();
});

// A watch refresh that lands WHILE a comment composer is open must be HELD, not applied — applyDiffUpdate
// rebuilds the diff DOM, which would destroy the composer textarea mid-type (input stalls / batched chars).
// It's flushed the moment the composer closes (save/cancel).
test("lazy-LOAD: a watch refresh is deferred while composing, then applied on close", async () => {
  const b1 = await makeReviewHtml(
    [{ path: "src/live.ts", before: "export const x = 1;\n", after: "export const x = 111;\n" }],
    { lazyLoad: true },
  );
  let bodies = await renderLazyBodies(b1.build);
  const v = await loadViewer(b1.html, {
    menuBridge: true,
    lazySourceData: b1.build.lazySourceData,
    getDiffBody: (idx) => bodies[idx] || "",
  });
  await v.openDiffFor("src/live.ts");
  await v.settle(120);
  await v.clickFirstDiffLine(); // place the diff caret so the composer has a target line
  await v.openComposer("q");
  assert.ok(v.visibleComposerInput(), "composer is open");

  const b2 = await makeReviewHtml(
    [{ path: "src/live.ts", before: "export const x = 1;\n", after: "export const x = 222;\n" }],
    { lazyLoad: true },
  );
  bodies = await renderLazyBodies(b2.build);
  await v.pushDiffUpdate(b2.build.update);
  await v.settle(120);
  assert.ok(v.visibleComposerInput(), "composer survives the watch refresh (update held)");
  assert.doesNotMatch(v.$("#diff2html-container").textContent, /222/, "diff is NOT rebuilt while composing");

  await v.writeAndSave("note"); // saving closes the composer, which flushes the held refresh
  await v.settle(120);
  assert.ok(!v.visibleComposerInput(), "composer closed after save");
  assert.match(v.$("#diff2html-container").textContent, /222/, "the held watch refresh is applied once composing ends");
  v.close();
});

// A watch refresh must not blank-then-reload files that DIDN'T change: their already-materialized body is
// snapshotted before the swap and re-filled synchronously, so it never flickers and isn't re-fetched.
test("lazy-LOAD: a watch refresh keeps an UNCHANGED file's body (no blank, no re-fetch)", async () => {
  const b1 = await makeReviewHtml(
    [
      { path: "src/a.ts", before: "const a = 1;\n", after: "const a = 1; // AAA\n" },
      { path: "src/b.ts", before: "const b = 2;\n", after: "const b = 2; // BBB1\n" },
    ],
    { lazyLoad: true },
  );
  let bodies = await renderLazyBodies(b1.build);
  const fetched = [];
  const v = await loadViewer(b1.html, {
    menuBridge: true,
    lazySourceData: b1.build.lazySourceData,
    getDiffBody: (idx) => { fetched.push(idx); return bodies[idx] || ""; },
  });
  await v.openDiffFor("src/a.ts");
  await v.settle(120);
  assert.match(v.$("#diff2html-container").textContent, /AAA/, "a.ts body materialized");
  const aIdx = Number((v.$("#diff2html-container .d2h-file-wrapper").id || "file-0").replace("file-", ""));
  fetched.length = 0; // ignore the initial-load fetches

  // Watch rebuild changes ONLY b.ts; a.ts is byte-identical.
  const b2 = await makeReviewHtml(
    [
      { path: "src/a.ts", before: "const a = 1;\n", after: "const a = 1; // AAA\n" },   // unchanged
      { path: "src/b.ts", before: "const b = 2;\n", after: "const b = 2; // BBB2\n" },   // changed
    ],
    { lazyLoad: true },
  );
  bodies = await renderLazyBodies(b2.build);
  await v.pushDiffUpdate(b2.build.update);
  await v.settle(120);

  assert.match(v.$("#diff2html-container").textContent, /AAA/, "unchanged a.ts body stays painted (no blank flash)");
  assert.ok(!fetched.includes(aIdx), "unchanged a.ts body served from the snapshot, NOT re-fetched over IPC");
  v.close();
});

// FLICKER-SAVER: when an OFF-SCREEN file changes but the file you're viewing doesn't (same file set+order),
// applyDiffUpdate must reconcile per-file — keeping the viewed file's exact DOM node (no re-render/flicker)
// and swapping only the changed off-screen wrapper.
test("lazy: off-screen change preserves the viewed file's wrapper node, swaps only the changed one", async () => {
  const b1 = await makeReviewHtml(
    [
      { path: "src/a.ts", before: "const a = 1;\n", after: "const a = 1; // AAA\n" },
      { path: "src/b.ts", before: "const b = 2;\n", after: "const b = 2; // BBB\n" },
    ],
    { lazyLoad: true },
  );
  let bodies = await renderLazyBodies(b1.build);
  const v = await loadViewer(b1.html, {
    menuBridge: true,
    lazySourceData: b1.build.lazySourceData,
    getDiffBody: (idx) => bodies[idx] || "",
  });
  await v.openDiffFor("src/a.ts");
  await v.settle(120);
  const aBefore = v.$('#diff2html-container .d2h-file-wrapper[data-path="src/a.ts"]');
  const bBefore = v.$('#diff2html-container .d2h-file-wrapper[data-path="src/b.ts"]');
  assert.ok(aBefore && bBefore, "both wrappers exist");

  // Watch: a.ts byte-identical, only b.ts changes.
  const b2 = await makeReviewHtml(
    [
      { path: "src/a.ts", before: "const a = 1;\n", after: "const a = 1; // AAA\n" },     // unchanged
      { path: "src/b.ts", before: "const b = 2;\n", after: "const b = 2; // BBB-CHANGED\n" }, // changed
    ],
    { lazyLoad: true },
  );
  bodies = await renderLazyBodies(b2.build);
  await v.pushDiffUpdate(b2.build.update);
  await v.settle(120);

  const aAfter = v.$('#diff2html-container .d2h-file-wrapper[data-path="src/a.ts"]');
  const bAfter = v.$('#diff2html-container .d2h-file-wrapper[data-path="src/b.ts"]');
  assert.equal(aAfter, aBefore, "viewed file's wrapper is the SAME DOM node — no flicker");
  assert.notEqual(bAfter, bBefore, "changed off-screen file's wrapper was swapped");
  v.close();
});

test("lazy: changed source stays painted until its replacement is ready, preserving caret and scroll", async () => {
  const before = Array.from({ length: 30 }, (_, i) => `const line${i} = ${i};`).join("\n") + "\n";
  const after1 = before.replace("const line20 = 20;", "const line20 = 200;");
  const after2 = after1.replace("const line3 = 3;", "const line3 = 300;");
  const b1 = await makeReviewHtml([{ path: "src/live.ts", before, after: after1 }], { lazyLoad: true });
  const b2 = await makeReviewHtml([{ path: "src/live.ts", before, after: after2 }], { lazyLoad: true });
  let sourceRecords = JSON.parse(b1.build.lazySourceData || "[]");
  let refreshPending = false;
  let resolveRefresh;
  const v = await loadViewer(b1.html, {
    menuBridge: true,
    sourceBridge(path) {
      const record = sourceRecords.find((item) => item.path === path) || null;
      if (!refreshPending) return record;
      return new Promise((resolve) => { resolveRefresh = () => resolve(record); });
    },
  });
  await v.openSourceFile("src/live.ts");
  v.window.setSourceCursor("src/live.ts", 12, 5, false, -1);
  const body = v.$("#source-body");
  body.scrollTop = 240;
  const oldTable = body.querySelector(".source-table");
  assert.ok(oldTable && /line20 = 200/.test(oldTable.textContent), "old source is visibly painted");

  sourceRecords = JSON.parse(b2.build.lazySourceData || "[]");
  refreshPending = true;
  v.window.__diffUpdateCb(b2.build.update);
  await v.settle(20);

  assert.equal(body.querySelector(".source-table"), oldTable, "old DOM remains on screen during the IPC fetch");
  assert.doesNotMatch(body.textContent, /Loading/i, "live refresh never exposes a loading placeholder");
  assert.equal(body.scrollTop, 240, "the visible viewport does not jump while loading");
  assert.equal(body.querySelector(".source-row.cursor-line")?.dataset.lineIndex, "12", "caret remains on its line while loading");

  resolveRefresh();
  await v.settle(100);
  assert.notEqual(body.querySelector(".source-table"), oldTable, "the ready source is swapped in once");
  assert.match(body.textContent, /line3 = 300/, "the refreshed content is visible");
  assert.equal(body.scrollTop, 240, "scrollTop survives the atomic repaint");
  assert.equal(body.querySelector(".source-row.cursor-line")?.dataset.lineIndex, "12", "caret survives the atomic repaint");
  v.close();
});

test("lazy: changed active diff is hydrated off-DOM and swapped without a blank frame", async () => {
  const before = Array.from({ length: 28 }, (_, i) => `const item${i} = ${i};`).join("\n") + "\n";
  const after1 = before.replace("const item20 = 20;", "const item20 = 200;");
  const after2 = after1.replace("const item21 = 21;", "const item21 = 210;");
  const b1 = await makeReviewHtml([{ path: "src/live.ts", before, after: after1 }], { lazyLoad: true });
  const b2 = await makeReviewHtml([{ path: "src/live.ts", before, after: after2 }], { lazyLoad: true });
  let bodies = await renderLazyBodies(b1.build);
  let refreshPending = false;
  let resolveRefresh;
  const v = await loadViewer(b1.html, {
    menuBridge: true,
    lazySourceData: b1.build.lazySourceData,
    getDiffBody(index) {
      const html = bodies[index] || "";
      if (!refreshPending) return html;
      return new Promise((resolve) => { resolveRefresh = () => resolve(html); });
    },
  });
  await v.openDiffFor("src/live.ts");
  const wrapperBefore = v.$('#diff2html-container .d2h-file-wrapper[data-path="src/live.ts"]');
  const rows = wrapperBefore.querySelectorAll(".d2h-file-side-diff:last-child tr");
  const cursorIndex = Math.min(8, Math.max(0, rows.length - 1));
  v.window.setDiffCursor("src/live.ts", "new", cursorIndex, 3, false);
  const cursorLineBefore = v.diffCaretLine();
  const container = v.$("#diff2html-container");
  container.scrollTop = 180;

  bodies = await renderLazyBodies(b2.build);
  refreshPending = true;
  v.window.__diffUpdateCb(b2.build.update);
  await v.settle(20);

  assert.equal(v.$('#diff2html-container .d2h-file-wrapper[data-path="src/live.ts"]'), wrapperBefore, "painted wrapper stays connected while the new body loads");
  assert.match(wrapperBefore.textContent, /item20 = 200/, "the old review remains readable instead of becoming a shell");
  assert.equal(container.scrollTop, 180, "the diff viewport does not jump while loading");

  resolveRefresh();
  await v.settle(100);
  const wrapperAfter = v.$('#diff2html-container .d2h-file-wrapper[data-path="src/live.ts"]');
  assert.notEqual(wrapperAfter, wrapperBefore, "one atomic swap installs the hydrated wrapper");
  assert.match(wrapperAfter.textContent, /item21 = 210/, "the refreshed diff body is visible");
  assert.equal(container.scrollTop, 180, "diff scrollTop survives the atomic swap");
  assert.equal(v.diffCaretLine(), cursorLineBefore, "the caret is restored by working-tree line number");
  v.close();
});
